let socket = null;

function connect() {
  socket = new WebSocket('ws://localhost:9223');

  socket.onopen = () => {
    console.log('[Web-curl] Connected to MCP Server');
    updateStatus(true);
  };

  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    console.log('[Web-curl] Command received:', message);

    try {
      let result;
      switch (message.type) {
        case 'NAVIGATE':
          result = await handleNavigate(message.url);
          break;
        case 'SNAPSHOT':
          result = await handleSnapshot();
          break;
        case 'ACTION':
          result = await handleAction(message.args);
          break;
        case 'LINKS':
          result = await handleLinks();
          break;
        case 'SCREENSHOT':
          result = await handleScreenshot();
          break;
        case 'TABS':
          result = await handleTabs(message.args);
          break;
        case 'CONSOLE':
          result = await handleConsole();
          break;
        case 'NETWORK':
          result = await handleNetwork();
          break;
        case 'COOKIES':
          result = await handleCookies(message.args);
          break;
        case 'CONFIGURE':
          result = await handleConfigure(message.args);
          break;
        case 'CLOSE':
          result = await handleClose();
          break;
        default:
          throw new Error('Unknown command type: ' + message.type);
      }
      
      socket.send(JSON.stringify({
        type: 'RESPONSE',
        id: message.id,
        payload: result
      }));
    } catch (error) {
      socket.send(JSON.stringify({
        type: 'ERROR',
        id: message.id,
        error: error.message
      }));
    }
  };

  socket.onclose = () => {
    console.log('[Web-curl] Disconnected. Retrying in 5s...');
    updateStatus(false);
    setTimeout(connect, 5000);
  };

  socket.onerror = (err) => {
    console.error('[Web-curl] Socket error:', err);
    updateStatus(false);
  };
}

async function handleNavigate(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.update(tab.id, { url });
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(`Navigated to ${url}`);
      }
    });
  });
}

async function handleSnapshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      let count = 1;
      const getRole = (el) => {
        const role = el.getAttribute('role');
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        switch (tag) {
          case 'a': return 'link';
          case 'button': return 'button';
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
          case 'nav': return 'navigation';
          case 'main': return 'main';
          case 'article': return 'article';
          case 'section': return 'region';
          case 'ul': case 'ol': return 'list';
          case 'li': return 'listitem';
          case 'p': return 'paragraph';
          case 'img': return 'img';
          case 'input': return el.getAttribute('type') === 'checkbox' ? 'checkbox' : 'textbox';
          default: return 'generic';
        }
      };

      const buildTree = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;

        const rect = el.getBoundingClientRect();
        const isInViewport = (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );

        const ref = 'e' + (count++);
        el.setAttribute('data-mcp-ref', ref);

        const node = {
          role: getRole(el),
          ref: ref,
          name: el.innerText?.split('\n')[0].substring(0, 60).trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '',
          visible: isInViewport
        };

        if (el instanceof HTMLAnchorElement) node.url = el.getAttribute('href');
        if (style.cursor === 'pointer') node.cursor = 'pointer';
        if (el.tagName.toLowerCase().match(/^h[1-3]$/)) {
            node.level = parseInt(el.tagName.substring(1));
        }

        const children = Array.from(el.children)
          .map(c => buildTree(c))
          .filter(c => c !== null);
        
        if (children.length > 0) node.children = children;
        return node;
      };

      return buildTree(document.body);
    }
  });

  const formatNode = (node, indent = '') => {
    const visibleChildren = node.children?.filter((c) => c.visible || (c.children && c.children.length > 0));
    if (!node.visible && (!visibleChildren || visibleChildren.length === 0)) return '';

    let line = `${indent}- ${node.role}`;
    if (node.name) line += ` "${node.name}"`;
    if (node.level) line += ` [level=${node.level}]`;
    line += ` [ref=${node.ref}]`;
    if (node.cursor) line += ` [cursor=${node.cursor}]`;
    
    let extra = '';
    if (node.url) extra += `\n${indent}  - /url: ${node.url}`;

    if (visibleChildren && visibleChildren.length > 0) {
      const childrenStr = visibleChildren
        .map((c) => formatNode(c, indent + '  '))
        .filter((s) => s !== '')
        .join('\n');
      return childrenStr ? `${line}:${extra}\n${childrenStr}` : line + extra;
    }
    return line + extra;
  };

  return formatNode(result);
}

async function handleLinks() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => ({
          text: a.innerText.trim(),
          href: a.href
        }))
        .filter(link => link.href && link.href.startsWith('http'));
    }
  });
  return result;
}

async function handleScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return `Screenshot captured via extension (Base64 length: ${dataUrl.length}). In a real scenario, this would be saved to the server's screenshots/ directory.`;
}

async function handleTabs(args) {
  const { action, index } = args;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  
  switch (action) {
    case 'list':
      return tabs.map((t, i) => `[${i}] ${t.active ? '*' : ' '} ${t.title} (${t.url})`).join('\n');
    case 'select':
      if (index !== undefined && tabs[index]) {
        await chrome.tabs.update(tabs[index].id, { active: true });
        return `Selected tab ${index}: ${tabs[index].title}`;
      }
      return 'Invalid tab index';
    case 'new':
      await chrome.tabs.create({});
      return 'Created new tab';
    case 'close':
      const targetIndex = index !== undefined ? index : tabs.findIndex(t => t.active);
      if (targetIndex !== -1 && tabs[targetIndex]) {
        await chrome.tabs.remove(tabs[targetIndex].id);
        return `Closed tab ${targetIndex}`;
      }
      return 'Could not close tab';
    default:
      return 'Unknown tab action';
  }
}

async function handleConsole() {
  return "Console logs are not directly streamable via chrome.scripting without a persistent debugger. Use the browser's DevTools for live logs.";
}

async function handleNetwork() {
  return "Network requests are not directly streamable via chrome.scripting. Use the browser's DevTools for live network inspection.";
}

async function handleCookies(args) {
  const { action, cookies } = args;
  switch (action) {
    case 'get':
      return await chrome.cookies.getAll({});
    case 'set':
      for (const c of cookies) {
        await chrome.cookies.set(c);
      }
      return 'Cookies set';
    case 'delete':
      for (const c of cookies) {
        await chrome.cookies.remove({ url: c.url, name: c.name });
      }
      return 'Cookies deleted';
    case 'clear':
      const all = await chrome.cookies.getAll({});
      for (const c of all) {
        await chrome.cookies.remove({ url: `http${c.secure ? 's' : ''}://${c.domain}${c.path}`, name: c.name });
      }
      return 'Cookies cleared';
    default:
      return 'Unknown cookie action';
  }
}

async function handleConfigure(args) {
  const { viewport, userAgent } = args;
  if (viewport) {
    // Note: Viewport resizing is limited in extension background scripts
    return 'Viewport configuration received (Note: Extension resizing is limited)';
  }
  if (userAgent) {
    return 'User agent configuration received (Note: Extension UA override requires declarativeNetRequest)';
  }
  return 'Configuration received';
}

async function handleClose() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.remove(tab.id);
  return 'Tab closed';
}

async function handleAction(args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [args],
    func: (args) => {
      const resolveSelector = (sel) => {
        if (sel.startsWith('ref:')) {
          return `[data-mcp-ref="${sel.substring(4)}"]`;
        }
        return sel;
      };

      const selector = args.selector ? resolveSelector(args.selector) : null;
      const el = selector ? document.querySelector(selector) : null;

      switch (args.action) {
        case 'click':
          if (!el) throw new Error('Element not found: ' + args.selector);
          el.click();
          return 'Clicked';
        case 'type':
          if (!el) throw new Error('Element not found: ' + args.selector);
          el.value = args.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Typed';
        case 'scroll':
          window.scrollBy(0, args.direction === 'up' ? -500 : 500);
          return 'Scrolled';
        case 'hover':
          if (!el) throw new Error('Element not found: ' + args.selector);
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          return 'Hovered';
        default:
          throw new Error('Action not supported via extension: ' + args.action);
      }
    }
  });
  return result;
}

function updateStatus(connected) {
  chrome.storage.local.set({ connected });
}

connect();
