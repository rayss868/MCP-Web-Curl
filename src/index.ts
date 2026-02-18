#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import puppeteer, { Browser, Page, ConsoleMessage, HTTPRequest } from 'puppeteer';
import { WebSocketServer, WebSocket } from 'ws';
import { franc } from 'franc-min';
import { Readable } from 'stream';
import { pipeline } from 'node:stream/promises';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import { fetchApi, FetchApiArgs, isValidFetchApiArgs } from './rest-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Project root is one level up from 'src' or 'build'
const PROJECT_ROOT = path.resolve(__dirname, '..');

let translate: any;
(async () => {
  try {
    translate = (await import('translate')).default || (await import('translate'));
  } catch (e) {
    console.error('Failed to load translate module');
  }
})();

interface BrowserActionArgs {
  action: 'click' | 'type' | 'scroll' | 'press_key' | 'hover' | 'waitForSelector';
  selector?: string;
  text?: string;
  direction?: 'up' | 'down';
  key?: string;
  timeout?: number;
}

interface ScreenshotArgs {
  filename?: string;
  fullPage?: boolean;
  destinationFolder?: string;
}

interface BrowserFlowArgs {
  /** If provided, navigate to this URL before doing anything else */
  url?: string;

  /** If true, opens a new tab before running the flow */
  newTab?: boolean;

  /** If provided, selects this tab index first (0-based) */
  tabIndex?: number;

  /** Navigation timeout (ms). Defaults to 90000 */
  navigationTimeoutMs?: number;

  /** If set, waits for network idle after navigation (recommended for SPAs). Defaults to true when url is provided. */
  waitForNetworkIdle?: boolean;

  /** Network idle wait timeout (ms). Defaults to 30000 */
  networkIdleTimeoutMs?: number;

  /** Network idle time window (ms). Defaults to 1000 */
  networkIdleTimeMs?: number;

  /** Extra delay after navigation to allow hydration. Defaults to 1500 */
  stabilizeMs?: number;

  /** Optional page interactions to run after navigation */
  actions?: BrowserActionArgs[];

  /** What to return at the end (defaults to snapshot tree) */
  result?:
    | { type: 'snapshot'; mode?: 'tree' | 'html'; startIndex?: number; endIndex?: number }
    | { type: 'screenshot'; filename?: string; fullPage?: boolean; destinationFolder?: string }
    | { type: 'links' }
    | { type: 'network'; includeStatic?: boolean }
    | { type: 'console' };
}

class WebCurlServer {
  private server: Server;
  private browser: Browser | null = null;
  private pages: Page[] = [];
  private activePageIndex: number = 0;
  private readonly SCREENSHOT_DIR = path.join(PROJECT_ROOT, 'screenshots');
  private readonly PID_FILE = path.join(PROJECT_ROOT, 'logs', 'browser.pid');
  private readonly MAX_TABS = 10;
  private networkRequests: Map<Page, any[]> = new Map();
  private consoleMessages: Map<Page, any[]> = new Map();
  private customScreenshotDirs: Set<string> = new Set();
  private proxy: string | null = null;
  private userAgent: string | null = null;
  private browserURL: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map();

  constructor() {
    this.setupWebSocketServer();
    this.server = new Server(
      {
        name: 'web-curl',
        version: '1.4.2',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.cleanupOldFiles();

    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    const cleanup = async () => {
      if (this.browser) await this.browser.close();
      if (this.wss) this.wss.close();
      await this.server.close();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.stdin.on('close', cleanup);
  }

  private cleanupOldFiles() {
    try {
      const now = Date.now();
      const expiryMs = 5 * 24 * 60 * 60 * 1000; // 5 days

      const cleanupDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > expiryMs) {
            fs.unlinkSync(filePath);
          }
        });
      };

      // Cleanup default directory
      cleanupDir(this.SCREENSHOT_DIR);

      // Cleanup custom directories used in this session
      this.customScreenshotDirs.forEach(dir => cleanupDir(dir));
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  private setupWebSocketServer() {
    // WebSocket bridge for Chrome Extension (Port 9223)
    const server = require('http').createServer();
    this.wss = new WebSocketServer({ noServer: true });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error('[WebSocket] Port 9223 in use, extension bridge unavailable');
      } else {
        console.error('[WebSocket] Server error:', err);
      }
    });

    server.on('upgrade', (request: any, socket: any, head: any) => {
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      console.error('[WebSocket] Extension connected');
      this.extensionSocket = ws;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve } = this.pendingRequests.get(message.id)!;
            this.pendingRequests.delete(message.id);
            resolve(message.payload);
          }
        } catch (e) {
          console.error('[WebSocket] Error parsing message:', e);
        }
      });

      ws.on('close', () => {
        console.error('[WebSocket] Extension disconnected');
        this.extensionSocket = null;
      });
    });

    try { server.listen(9223); } catch (e) {}
  }

  private async killExistingBrowser() {
    try {
      if (fs.existsSync(this.PID_FILE)) {
        const pid = parseInt(fs.readFileSync(this.PID_FILE, 'utf8'));
        if (!isNaN(pid)) {
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (e) {}
        }
        fs.unlinkSync(this.PID_FILE);
      }
    } catch (e) {}
  }

  private async getBrowser() {
    if (this.browser) return this.browser;

    const launchOptions: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--font-render-hinting=none',
        '--window-size=1920,1080'
      ]
    };

    if (this.proxy) launchOptions.args.push(`--proxy-server=${this.proxy}`);
    const userDataDir = path.join(PROJECT_ROOT, 'user_data');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    launchOptions.userDataDir = userDataDir;

    if (this.browserURL) {
      this.browser = await puppeteer.connect({ browserURL: this.browserURL });
    } else {
      this.browser = await puppeteer.launch(launchOptions);
      const logsDir = path.join(PROJECT_ROOT, 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const pid = this.browser.process()?.pid;
      fs.writeFileSync(this.PID_FILE, pid ? pid.toString() : '');
    }

    this.browser.on('disconnected', () => {
      this.browser = null;
      this.pages = [];
    });

    return this.browser;
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      if (this.browser) {
        console.error('[Browser] Idle timeout, closing...');
        await this.browser.close();
        this.browser = null;
        this.pages = [];
      }
    }, 15 * 60 * 1000); // 15 minute idle timeout
  }

  private async getPage(index?: number): Promise<Page> {
    const browser = await this.getBrowser();
    const idx = index !== undefined ? index : this.activePageIndex;

    if (!this.pages[idx]) {
      const page = await this.createNewPage();
      this.pages[idx] = page;
      return page;
    }
    return this.pages[idx];
  }

  private async createNewPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    await this.setupPage(page);

    // LRU-style tab management
    if (this.pages.length >= this.MAX_TABS) {
      const oldest = this.pages.shift();
      await oldest?.close();
    }
    this.pages.push(page);
    return page;
  }

  private async setupPage(page: Page) {
    await page.setViewport({ width: 1280, height: 800 });
    if (this.userAgent) await page.setUserAgent(this.userAgent);

    page.on('console', (msg: ConsoleMessage) => {
      const msgs = this.consoleMessages.get(page) || [];
      msgs.push({ type: msg.type(), text: msg.text(), location: msg.location() });
      this.consoleMessages.set(page, msgs.slice(-100));
    });

    page.on('request', (req: HTTPRequest) => {
      const reqs = this.networkRequests.get(page) || [];
      reqs.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        headers: req.headers()
      });
      this.networkRequests.set(page, reqs.slice(-100));
    });

    page.on('close', () => {
      this.networkRequests.delete(page);
      this.consoleMessages.delete(page);
      this.pages = this.pages.filter(p => p !== page);
    });
  }

  private async getAccessibilityTree(page: Page): Promise<string> {
    const tree = await page.evaluate(() => {
      const getRole = (el: HTMLElement): string => {
        const role = el.getAttribute('role');
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        switch (tag) {
          case 'button': return 'button';
          case 'input': return (el as HTMLInputElement).type === 'button' ? 'button' : 'textbox';
          case 'a': return 'link';
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
          case 'img': return 'image';
          case 'table': return 'table';
          case 'form': return 'form';
          default: return 'generic';
        }
      };

      const buildTree = (el: HTMLElement): any => {
        const rect = el.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
        if (!isVisible) return null;

        const node: any = {
          role: getRole(el),
          name: el.getAttribute('aria-label') || el.innerText?.split('\n')[0].substring(0, 50).trim() || '',
          ref: el.getAttribute('data-mcp-ref') || null
        };

        if (!node.ref && (['button', 'link', 'textbox'].includes(node.role) || el.onclick)) {
          const id = Math.random().toString(36).substring(7);
          el.setAttribute('data-mcp-ref', id);
          node.ref = id;
        }

        const children = Array.from(el.children)
          .map(child => buildTree(child as HTMLElement))
          .filter(c => c !== null);

        if (children.length > 0) node.children = children;
        return node;
      };

      return buildTree(document.body);
    });

    const formatNode = (node: any, indent: string = ''): string => {
      let out = `${indent}${node.role}: "${node.name}"${node.ref ? ` [ref:${node.ref}]` : ''}\n`;
      if (node.children) {
        node.children.forEach((c: any) => { out += formatNode(c, indent + '  '); });
      }
      return out;
    };

    return formatNode(tree);
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'browser_navigate',
          description:
            'Open a URL in the active tab. Use this before snapshot/action/screenshot. Waits for domcontentloaded, then tries network-idle (up to 30s) + a short stabilization delay (useful for SPAs).',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The absolute URL to navigate to (e.g., https://example.com)' }
            },
            required: ['url']
          }
        },
        {
          name: 'browser_flow',
          description:
            'One-call workflow to reduce tool-chaining: optional navigate → optional wait/stabilize → optional actions → return ONE result (snapshot OR screenshot OR links OR console OR network). Use when the user wants multiple steps like “open this then screenshot”.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Optional URL to open before running actions.' },
              newTab: { type: 'boolean', description: 'If true, opens a new tab first (default false).' },
              tabIndex: { type: 'number', description: 'Optional tab index to select before running the flow.' },
              navigationTimeoutMs: { type: 'number', description: 'Navigation timeout in ms (default 90000).' },
              waitForNetworkIdle: {
                type: 'boolean',
                description: 'After navigation, wait for network-idle (recommended for SPAs). Default true when url is provided.'
              },
              networkIdleTimeoutMs: { type: 'number', description: 'Network-idle wait timeout in ms (default 30000).' },
              networkIdleTimeMs: { type: 'number', description: 'Network-idle window in ms (default 1000).' },
              stabilizeMs: { type: 'number', description: 'Extra delay after navigation to let hydration finish (default 1500).' },
              actions: {
                type: 'array',
                description: 'Optional list of page interactions to run after navigation.',
                items: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['click', 'type', 'scroll', 'press_key', 'hover', 'waitForSelector'], description: 'Interaction type.' },
                    selector: { type: 'string', description: 'CSS selector or ref from browser_snapshot (e.g., ref:abcd).' },
                    text: { type: 'string', description: 'Text to type (for action="type").' },
                    direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (for action="scroll").' },
                    key: { type: 'string', description: 'Keyboard key (for action="press_key").' },
                    timeout: { type: 'number', description: 'Wait timeout for selector-based actions (default 30000).' }
                  },
                  required: ['action']
                }
              },
              result: {
                type: 'object',
                description: 'What to return at the end. Defaults to {type:"snapshot", mode:"tree"}.',
                properties: {
                  type: { type: 'string', enum: ['snapshot', 'screenshot', 'links', 'network', 'console'], description: 'Final output type.' },
                  mode: { type: 'string', enum: ['tree', 'html'], description: 'For snapshot only: tree (default) or html slice.' },
                  startIndex: { type: 'number', description: 'For snapshot html: slice start (default 0).' },
                  endIndex: { type: 'number', description: 'For snapshot html: slice end (default startIndex+20000).' },
                  filename: { type: 'string', description: 'For screenshot: custom filename.' },
                  fullPage: { type: 'boolean', description: 'For screenshot: full page (true) or viewport (false). Default true.' },
                  destinationFolder: { type: 'string', description: 'For screenshot: output directory (relative to project root or absolute).' },
                  includeStatic: { type: 'boolean', description: 'For network: include images/fonts/css (default false).' }
                },
                required: ['type']
              }
            }
          }
        },
        {
          name: 'batch_navigate',
          description: 'Open multiple URLs, each in its own new tab (sequential). Use when you need many pages ready to inspect. Returns a list with tab indexes.',
          inputSchema: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' }, description: 'An array of absolute URLs to open.' }
            },
            required: ['urls']
          }
        },
        {
          name: 'browser_snapshot',
          description: 'Return a TEXT snapshot of the current page (NOT an image). Default mode "tree" returns a compact accessibility tree with [ref:...] you can click/type into. Use mode "html" to get raw HTML slices (20KB default) with startIndex/endIndex.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['tree', 'html'], description: 'Snapshot mode: "tree" (accessibility tree) or "html" (raw HTML slice). Defaults to "tree".' },
              startIndex: { type: 'number', description: 'Start index for HTML slicing (mode="html"). Defaults to 0.' },
              endIndex: { type: 'number', description: 'End index for HTML slicing (mode="html"). Defaults to startIndex + 20000 (clamped to HTML length).' }
            }
          }
        },
        {
          name: 'browser_action',
          description: 'Interact with the current page (click/type/scroll/hover/press_key/waitForSelector). For best reliability, use ref IDs from browser_snapshot (tree) like "ref:abcd".',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'scroll', 'press_key', 'hover', 'waitForSelector'], description: 'The type of interaction to perform.' },
              selector: { type: 'string', description: 'The target element. Can be a CSS selector or a reference ID from a snapshot (e.g., \"ref:e12\"). Required for click, type, hover, and waitForSelector.' },
              text: { type: 'string', description: 'The text to type into the element. Required for the \"type\" action.' },
              direction: { type: 'string', enum: ['up', 'down'], description: 'The direction to scroll. Required for the \"scroll\" action.' },
              key: { type: 'string', description: 'The keyboard key to press (e.g., \"Enter\", \"ArrowLeft\"). Required for the \"press_key\" action.' },
              timeout: { type: 'number', description: 'Maximum time to wait for the element to appear, in milliseconds (default: 30000).' }
            },
            required: ['action']
          }
        },
        {
          name: 'take_screenshot',
          description: 'Capture a PNG screenshot and return the local file path. Default fullPage=true (can be slow on very long pages); set fullPage=false for a fast viewport-only screenshot.',
          inputSchema: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Optional custom filename for the screenshot (e.g., page.png).' },
              fullPage: { type: 'boolean', description: 'true=full page, false=viewport only. Default true.' },
              destinationFolder: { type: 'string', description: 'Optional output directory (relative to project root or absolute). Directory will be created if missing.' }
            }
          }
        },
        {
          name: 'browser_network_requests',
          description: 'Retrieves a log of network requests (XHR/Fetch) made by the current page since it was loaded. Useful for inspecting API calls or data flowing behind the scenes.',
          inputSchema: {
            type: 'object',
            properties: {
              includeStatic: {
                type: 'boolean',
                description: 'Whether to include static resources like images, fonts, and stylesheets. Defaults to false (only XHR/Fetch).',
                default: false
              }
            }
          }
        },
        {
          name: 'browser_console_messages',
          description: 'Retrieves recent console logs, warnings, and errors emitted by the current page. Useful for debugging page behavior or capturing data printed to the console.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'browser_configure',
          description: 'Set browser-wide settings (proxy, user-agent, viewport). Sessions are always persisted automatically using the local user_data/ profile.',
          inputSchema: {
            type: 'object',
            properties: {
              proxy: { type: 'string', description: 'Proxy server URL (e.g., http://proxy.example.com:8080).' },
              userAgent: { type: 'string', description: 'Custom User-Agent string to identify the browser.' },
              viewport: {
                type: 'object',
                properties: {
                  width: { type: 'number', description: 'Viewport width in pixels.' },
                  height: { type: 'number', description: 'Viewport height in pixels.' }
                }
              }
            }
          }
        },
        {
          name: 'browser_links',
          description: 'Extracts all valid HTTP/HTTPS links from the current page, returning their visible text and absolute URLs.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'browser_tabs',
          description: 'Manages multiple browser tabs. You can list open tabs, create new ones, close specific tabs, or switch between them. The browser supports up to 10 concurrent tabs with automatic LRU rotation.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: 'The tab management action to perform.' },
              index: { type: 'number', description: 'The index of the tab to select or close. If omitted for \"close\", the active tab is closed.' }
            },
            required: ['action']
          }
        },
        {
          name: 'parse_document',
          description: 'Downloads and extracts text content from a PDF or DOCX file at a given URL. Useful for researching documents that are not standard HTML pages.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL of the PDF or DOCX document.' }
            },
            required: ['url']
          }
        },
        {
          name: 'fetch_api',
          description: 'Performs a standard REST API request. Supports custom methods, headers, and request bodies. Responses are truncated to a specified limit to prevent context overflow.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The API endpoint URL.' },
              method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, etc.).' },
              headers: { type: 'object', description: 'Optional HTTP headers.' },
              body: { type: 'string', description: 'Optional request body.' },
              limit: { type: 'number', description: 'Maximum number of characters to return from the response body.' }
            },
            required: ['url', 'method', 'limit']
          }
        },
        {
          name: 'google_search',
          description: 'Performs a web search using the Google Custom Search API. Supports advanced filtering by language, region, site, and date range.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search query string.' },
              num: { type: 'number', description: 'Number of search results to return (1-10).' },
              start: { type: 'number', description: 'The index of the first result to return.' },
              language: { type: 'string', description: 'Language code (e.g., \"en\", \"id\").' },
              region: { type: 'string', description: 'Country code (e.g., \"US\", \"ID\").' },
              site: { type: 'string', description: 'Restrict search to a specific domain (e.g., \"wikipedia.org\").' },
              dateRestrict: { type: 'string', description: 'Restrict results by date (e.g., \"d1\" for past day, \"w1\" for past week, \"m1\" for past month, \"y1\" for past year).' }
            },
            required: ['query']
          }
        },
        {
          name: 'smart_command',
          description: 'Processes a natural language command by detecting its language, translating it to English if necessary, enriching the query, and performing a Google search. Ideal for complex or non-English research intents.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The natural language research command or question.' },
              debug: { type: 'boolean', description: 'Whether to return detailed processing steps (language, enriched query).' }
            },
            required: ['command']
          }
        },
        {
          name: 'download_file',
          description: 'Downloads a file from a URL directly to the local file system. Ensures the destination folder exists and handles streaming for large files.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The URL of the file to download.' },
              destinationFolder: { type: 'string', description: 'The local directory where the file should be saved.' },
              filename: { type: 'string', description: 'Optional custom filename. If omitted, the name is derived from the URL.' }
            },
            required: ['url', 'destinationFolder']
          }
        },
        {
          name: 'multi_search',
          description: 'Executes multiple Google search queries in parallel. Returns a combined list of results for each query. Highly efficient for broad research across multiple related topics.',
          inputSchema: {
            type: 'object',
            properties: {
              queries: { type: 'array', items: { type: 'string' }, description: 'An array of search query strings.' }
            },
            required: ['queries']
          }
        },
        {
          name: 'browser_close',
          description: 'Immediately terminates the browser process and closes all open tabs. Note: The browser also closes automatically after 1 minute of inactivity.',
          inputSchema: { type: 'object', properties: {} }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      // Extension Priority: If extension is connected, route commands through it
      // DISABLED BY USER REQUEST
      /*
      const extensionTools = [
        'browser_navigate',
        'browser_snapshot',
        'browser_action',
        'browser_links',
        'take_screenshot',
        'browser_tabs',
        'browser_console_messages',
        'browser_network_requests',
        'browser_configure',
        'browser_close'
      ];

      if (this.extensionSocket && extensionTools.includes(toolName)) {
        const id = Math.random().toString(36).substring(7);
        let type = '';
        if (toolName === 'browser_navigate') type = 'NAVIGATE';
        else if (toolName === 'browser_snapshot') type = 'SNAPSHOT';
        else if (toolName === 'browser_action') type = 'ACTION';
        else if (toolName === 'browser_links') type = 'LINKS';
        else if (toolName === 'take_screenshot') type = 'SCREENSHOT';
        else if (toolName === 'browser_tabs') type = 'TABS';
        else if (toolName === 'browser_console_messages') type = 'CONSOLE';
        else if (toolName === 'browser_network_requests') type = 'NETWORK';
        else if (toolName === 'browser_configure') type = 'CONFIGURE';
        else if (toolName === 'browser_close') type = 'CLOSE';

        return new Promise((resolve, reject) => {
          this.pendingRequests.set(id, {
            resolve: (payload: any) => resolve({ content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }),
            reject
          });
          this.extensionSocket?.send(JSON.stringify({ id, type, url: (args as any)?.url, args }));
          
          // Timeout for extension response
          setTimeout(() => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              reject(new McpError(ErrorCode.InternalError, 'Extension request timed out'));
            }
          }, 30000);
        });
      }
      */

      try {
        this.resetIdleTimer();
        if (toolName === 'browser_close') {
          if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.pages = [];
            this.activePageIndex = 0;
            this.networkRequests.clear();
            this.consoleMessages.clear();
          }
          return { content: [{ type: 'text', text: 'Browser closed' }] };
        }

        if (toolName === 'browser_tabs') {
          const { action, index } = args as any;
          const browser = await this.getBrowser();
          if (action === 'list') {
            const list = await Promise.all(this.pages.map(async (p, i) => ({
              index: i,
              active: i === this.activePageIndex,
              url: p.url(),
              title: await p.title()
            })));
            return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
          }
          if (action === 'new') {
            await this.createNewPage();
            this.activePageIndex = this.pages.length - 1;
            return { content: [{ type: 'text', text: `Opened new tab at index ${this.activePageIndex}` }] };
          }
          if (action === 'select') {
            if (index === undefined || index < 0 || index >= this.pages.length) throw new Error('Invalid tab index');
            this.activePageIndex = index;
            return { content: [{ type: 'text', text: `Selected tab ${index}` }] };
          }
          if (action === 'close') {
            const targetIdx = index !== undefined ? index : this.activePageIndex;
            if (targetIdx < 0 || targetIdx >= this.pages.length) throw new Error('Invalid tab index');
            const pageToClose = this.pages[targetIdx];
            await pageToClose.close(); // Trigger 'close' event handler
            return { content: [{ type: 'text', text: `Closed tab ${targetIdx}` }] };
          }
        }

        const page = await this.getPage();
        if (toolName === 'browser_navigate') {
          const { url } = args as any;
          this.networkRequests.set(page, []);
          this.consoleMessages.set(page, []);
          
          // Align with working test script logic
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          
          try {
            // Wait for network idle (more reliable for SPAs)
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 });
          } catch (e) {
            console.error('[Browser] Network idle timeout, proceeding anyway');
          }

          // Extra stabilization delay for hydrate
          await new Promise(r => setTimeout(r, 1500));
          
          return { content: [{ type: 'text', text: `Navigated to ${url}` }] };
        } else if (toolName === 'browser_flow') {
          const flow = (args || {}) as BrowserFlowArgs;

          // Tab selection / creation
          if (flow.tabIndex !== undefined) {
            if (flow.tabIndex < 0 || flow.tabIndex >= this.pages.length) throw new Error('Invalid tabIndex');
            this.activePageIndex = flow.tabIndex;
          }
          if (flow.newTab) {
            await this.createNewPage();
            this.activePageIndex = this.pages.length - 1;
          }

          const p = await this.getPage();

          // Optional navigate
          if (flow.url) {
            const navTimeout = flow.navigationTimeoutMs ?? 90000;
            this.networkRequests.set(p, []);
            this.consoleMessages.set(p, []);
            await p.goto(flow.url, { waitUntil: 'domcontentloaded', timeout: navTimeout });

            const shouldWaitIdle = flow.waitForNetworkIdle ?? true;
            if (shouldWaitIdle) {
              const idleTime = flow.networkIdleTimeMs ?? 1000;
              const idleTimeout = flow.networkIdleTimeoutMs ?? 30000;
              try {
                await p.waitForNetworkIdle({ idleTime, timeout: idleTimeout });
              } catch (e) {
                console.error('[Browser] Network idle timeout (browser_flow), proceeding anyway');
              }
            }

            const stabilize = flow.stabilizeMs ?? 1500;
            if (stabilize > 0) await new Promise(r => setTimeout(r, stabilize));
          }

          // Optional actions
          if (flow.actions && flow.actions.length > 0) {
            for (const action of flow.actions) {
              await this.performBrowserAction(action);
            }
          }

          const result = flow.result ?? { type: 'snapshot', mode: 'tree' };

          if (result.type === 'snapshot') {
            const mode = result.mode ?? 'tree';
            if (mode === 'html') {
              const html = await p.content();
              const startIndex = result.startIndex ?? 0;
              const safeStart = Math.max(0, Math.floor(startIndex));
              const defaultEnd = safeStart + 20000;
              const safeEnd = Math.min(html.length, result.endIndex !== undefined ? Math.floor(result.endIndex) : defaultEnd);
              const slice = html.slice(safeStart, safeEnd);
              const remainingCharacters = Math.max(0, html.length - safeEnd);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        mode: 'html',
                        totalLength: html.length,
                        startIndex: safeStart,
                        endIndex: safeEnd,
                        remainingCharacters,
                        content: slice
                      },
                      null,
                      2
                    )
                  }
                ]
              };
            }

            const tree = await this.getAccessibilityTree(p);
            return { content: [{ type: 'text', text: tree }] };
          }

          if (result.type === 'screenshot') {
            const filePath = await this.takeScreenshot({
              filename: result.filename,
              fullPage: result.fullPage,
              destinationFolder: result.destinationFolder
            });
            return { content: [{ type: 'text', text: `Screenshot saved: ${filePath}` }] };
          }

          if (result.type === 'links') {
            const links = await p.evaluate(() =>
              Array.from(document.querySelectorAll('a'))
                .map(a => ({ text: a.innerText.trim(), href: (a as HTMLAnchorElement).href }))
                .filter(l => l.href.startsWith('http'))
            );
            return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
          }

          if (result.type === 'console') {
            return { content: [{ type: 'text', text: JSON.stringify(this.consoleMessages.get(p) || [], null, 2) }] };
          }

          if (result.type === 'network') {
            const includeStatic = result.includeStatic ?? false;
            const reqs = this.networkRequests.get(p) || [];
            const filtered = includeStatic ? reqs : reqs.filter(r => !['image', 'font', 'stylesheet', 'media'].includes(r.resourceType));
            return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
          }

          throw new Error('Invalid browser_flow result type');
        } else if (toolName === 'batch_navigate') {
          const { urls } = args as any;
          const results = [];
          for (const url of urls) {
            try {
              const p = await this.createNewPage();
              await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
              try {
                await p.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 });
              } catch (e) {}
              await new Promise(r => setTimeout(r, 1500));
              results.push({ url, status: 'success', tabIndex: this.pages.length - 1 });
            } catch (e: any) {
              results.push({ url, status: 'error', error: e.message });
            }
          }
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } else if (toolName === 'multi_search') {
          const { queries } = args as any;
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) throw new Error('Google Search API keys not configured');

          const searchResults = await Promise.all(queries.map(async (query: string) => {
            const url = new URL('https://www.googleapis.com/customsearch/v1');
            url.searchParams.set('key', apiKey);
            url.searchParams.set('cx', cx);
            url.searchParams.set('q', query);
            const response = await fetch(url.toString());
            const data = await response.json() as any;
            return {
              query,
              results: (data.items || []).map((item: any) => ({ title: item.title, link: item.link, snippet: item.snippet }))
            };
          }));
          return { content: [{ type: 'text', text: JSON.stringify(searchResults, null, 2) }] };
        } else if (toolName === 'browser_snapshot') {
          const { mode = 'tree', startIndex = 0, endIndex } = args as any;
          if (mode === 'html') {
            const html = await page.content();
            const safeStart = Math.max(0, Math.floor(startIndex));
            const defaultEnd = safeStart + 20000;
            const safeEnd = Math.min(html.length, endIndex !== undefined ? Math.floor(endIndex) : defaultEnd);
            const slice = html.slice(safeStart, safeEnd);
            const remainingCharacters = Math.max(0, html.length - safeEnd);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      mode: 'html',
                      totalLength: html.length,
                      startIndex: safeStart,
                      endIndex: safeEnd,
                      remainingCharacters,
                      content: slice
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }
          const tree = await this.getAccessibilityTree(page);
          return { content: [{ type: 'text', text: tree }] };
        } else if (toolName === 'browser_action') {
          const result = await this.performBrowserAction(args as any);
          return { content: [{ type: 'text', text: result }] };
        } else if (toolName === 'take_screenshot') {
          const filePath = await this.takeScreenshot(args as any);
          return { content: [{ type: 'text', text: `Screenshot saved: ${filePath}` }] };
        } else if (toolName === 'browser_network_requests') {
          const { includeStatic } = args as any;
          const reqs = this.networkRequests.get(page) || [];
          const filtered = includeStatic ? reqs : reqs.filter(r => !['image', 'font', 'stylesheet', 'media'].includes(r.resourceType));
          return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
        } else if (toolName === 'browser_console_messages') {
          return { content: [{ type: 'text', text: JSON.stringify(this.consoleMessages.get(page) || [], null, 2) }] };
        } else if (toolName === 'browser_links') {
          const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.innerText.trim(), href: a.href })).filter(l => l.href.startsWith('http')));
          return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] };
        } else if (toolName === 'browser_configure') {
          const { proxy, userAgent, viewport } = args as any;
          let restartNeeded = false;

          if (proxy !== undefined && proxy !== this.proxy) {
            this.proxy = proxy;
            restartNeeded = true;
          }
          if (userAgent !== undefined && userAgent !== this.userAgent) {
            this.userAgent = userAgent;
            restartNeeded = true;
          }
          if (restartNeeded && this.browser) {
            await this.browser.close();
            this.browser = null;
            this.pages = [];
            this.activePageIndex = 0;
          }

          if (viewport) {
            for (const page of this.pages) {
              await page.setViewport(viewport);
            }
          }
          return { content: [{ type: 'text', text: restartNeeded ? 'Configuration updated (Browser restarted)' : 'Configuration updated' }] };
        } else if (toolName === 'parse_document') {
          const { url } = args as any;
          const res = await fetch(url);
          const data = await pdf(Buffer.from(await res.arrayBuffer()));
          return { content: [{ type: 'text', text: data.text }] };
        } else if (toolName === 'fetch_api') {
          if (!isValidFetchApiArgs(args)) throw new Error('Invalid args');
          return { content: [{ type: 'text', text: JSON.stringify(await fetchApi(args as any), null, 2) }] };
        } else if (toolName === 'google_search') {
          const { query, num, start, language, region, site, dateRestrict } = args as any;
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) throw new Error('Google Search API keys not configured');

          const url = new URL('https://www.googleapis.com/customsearch/v1');
          url.searchParams.set('key', apiKey);
          url.searchParams.set('cx', cx);
          url.searchParams.set('q', query);
          if (num) url.searchParams.set('num', String(num));
          if (start) url.searchParams.set('start', String(start));
          if (language) url.searchParams.set('lr', `lang_${language}`);
          if (region) url.searchParams.set('cr', `country${region}`);
          if (site) url.searchParams.set('siteSearch', site);
          if (dateRestrict) url.searchParams.set('dateRestrict', dateRestrict);

          const response = await fetch(url.toString());
          if (!response.ok) throw new Error(`Google Search error: ${response.statusText}`);
          const data = await response.json() as any;
          const results = (data.items || []).map((item: any) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } else if (toolName === 'smart_command') {
          const { command } = args as any;
          let query = command;
          const langCode = franc(command);
          
          if (langCode !== 'eng' && langCode !== 'und' && translate) {
            try {
              query = await translate(command, 'en');
            } catch (e) {
              console.error('Translation failed, using original command');
            }
          }

          // Simple enrichment
          if (!query.toLowerCase().includes('best') && !query.toLowerCase().includes('tips')) {
            query += ' best tips';
          }

          // Internal call to google_search logic
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) throw new Error('Google Search API keys not configured');

          const url = new URL('https://www.googleapis.com/customsearch/v1');
          url.searchParams.set('key', apiKey);
          url.searchParams.set('cx', cx);
          url.searchParams.set('q', query);
          
          const response = await fetch(url.toString());
          const data = await response.json() as any;
          const results = (data.items || []).map((item: any) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));

          return {
            content: [{
              type: 'text',
              text: `Detected language: ${langCode}\nEnriched query: ${query}\n\nResults:\n${JSON.stringify(results, null, 2)}`
            }]
          };
        } else if (toolName === 'download_file') {
          const { url, destinationFolder, filename } = args as any;
          // Resolve relative paths against PROJECT_ROOT to keep data central
          const destPath = path.isAbsolute(destinationFolder)
            ? destinationFolder
            : path.resolve(PROJECT_ROOT, destinationFolder);
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
          
          const finalFilename = filename || path.basename(new URL(url).pathname) || 'downloaded_file';
          const filePath = path.join(destPath, finalFilename);
          
          const fileStream = fs.createWriteStream(filePath);
          await pipeline(Readable.fromWeb(response.body as any), fileStream);
          
          return { content: [{ type: 'text', text: `File downloaded to: ${filePath}` }] };
        }
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      } catch (error: any) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    });
  }

  private async resolveSelector(selector: string): Promise<string> {
    if (selector.startsWith('ref:')) {
      const ref = selector.substring(4);
      return `[data-mcp-ref="${ref}"]`;
    }
    return selector;
  }

  private async performBrowserAction(args: BrowserActionArgs): Promise<string> {
    const page = await this.getPage();
    const timeout = args.timeout || 30000;
    const selector = args.selector ? await this.resolveSelector(args.selector) : null;

    if (args.action === 'click') { await page.waitForSelector(selector!, { timeout }); await page.click(selector!); return 'Clicked'; }
    if (args.action === 'type') { await page.waitForSelector(selector!, { timeout }); await page.type(selector!, args.text!); return 'Typed'; }
    if (args.action === 'scroll') { await page.evaluate((d) => window.scrollBy(0, d === 'up' ? -500 : 500), args.direction); return 'Scrolled'; }
    if (args.action === 'press_key') { await page.keyboard.press(args.key as any); return 'Pressed'; }
    if (args.action === 'hover') { await page.waitForSelector(selector!, { timeout }); await page.hover(selector!); return 'Hovered'; }
    if (args.action === 'waitForSelector') { await page.waitForSelector(selector!, { timeout }); return 'Found'; }
    return 'Action completed';
  }

  private async takeScreenshot(args: ScreenshotArgs): Promise<string> {
    const page = await this.getPage();
    
    let destDir = this.SCREENSHOT_DIR;
    if (args.destinationFolder) {
      try {
        // Resolve path: if relative, resolve against PROJECT_ROOT
        destDir = path.isAbsolute(args.destinationFolder)
          ? args.destinationFolder
          : path.resolve(PROJECT_ROOT, args.destinationFolder);
        
        // Basic syntax validation: check if path is valid for the OS
        // On Windows, we check for invalid characters
        if (process.platform === 'win32') {
          const invalidChars = /[<>:"|?*]/;
          const driveLetter = /^[a-zA-Z]:\\/;
          // If it's absolute, it should start with drive letter or UNC
          if (path.isAbsolute(destDir) && !driveLetter.test(destDir) && !destDir.startsWith('\\\\')) {
             throw new Error('Invalid Windows path format');
          }
          if (invalidChars.test(destDir.replace(driveLetter, ''))) {
            throw new Error('Path contains invalid characters');
          }
        }
      } catch (e: any) {
        throw new Error(`Invalid directory syntax: ${e.message}`);
      }
    }

    // Auto-create directory if it doesn't exist
    if (!fs.existsSync(destDir)) {
      try {
        fs.mkdirSync(destDir, { recursive: true });
      } catch (e: any) {
        throw new Error(`Failed to create directory: ${e.message}`);
      }
    }

    // Track custom directory for cleanup
    if (destDir !== this.SCREENSHOT_DIR) {
      this.customScreenshotDirs.add(destDir);
    }

    const filePath = path.join(destDir, args.filename || `screenshot-${Date.now()}.png`);
    
    // Critical stabilization delay for Ubuntu Server rendering
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await page.screenshot({
      path: filePath as any,
      fullPage: args.fullPage !== false,
      type: 'png',
      omitBackground: false
    });
    return filePath;
  }

  async run() {
    await this.killExistingBrowser();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web-curl MCP server running');
  }
}

const server = new WebCurlServer();
server.run().catch(console.error);
