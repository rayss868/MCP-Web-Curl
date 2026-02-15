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
        version: '1.4.0',
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
    try {
      // Create server without port first to attach error listener
      this.wss = new WebSocketServer({ noServer: true });
      
      const server = require('http').createServer();
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error('[WebSocket] Port 9223 already in use. Bridge might be active in another session.');
        } else {
          console.error('[WebSocket] Server error:', err.message);
        }
      });

      server.listen(9223, () => {
        console.error('[WebSocket] Server listening on port 9223');
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
            if (message.type === 'RESPONSE' || message.type === 'ERROR') {
              const pending = this.pendingRequests.get(message.id);
              if (pending) {
                if (message.type === 'ERROR') pending.reject(new Error(message.error));
                else pending.resolve(message.payload);
                this.pendingRequests.delete(message.id);
              }
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
    } catch (e: any) {
      console.error('[WebSocket] Failed to start server:', e.message);
    }
  }

  private async killExistingBrowser() {
    try {
      if (fs.existsSync(this.PID_FILE)) {
        const pid = parseInt(fs.readFileSync(this.PID_FILE, 'utf8'));
        if (!isNaN(pid)) {
          console.error(`[Startup] Found existing browser PID: ${pid}. Killing it to ensure single instance.`);
          try {
            if (process.platform === 'win32') {
              execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            } else {
              process.kill(pid, 'SIGKILL');
            }
          } catch (e) {
            // Process might already be dead
          }
        }
        fs.unlinkSync(this.PID_FILE);
      }
    } catch (error) {
      console.error('Error killing existing browser:', error);
    }
  }

  private async getBrowser() {
    if (!this.browser) {
      // Priority 1: Use browserURL if explicitly provided
      if (this.browserURL) {
        try {
          this.browser = await puppeteer.connect({
            browserURL: this.browserURL,
            defaultViewport: { width: 1280, height: 800 }
          });
          console.error(`[Browser] Connected to existing instance at ${this.browserURL}`);
          
          // Sync existing pages
          this.pages = await this.browser.pages();
          for (const page of this.pages) {
            await this.setupPage(page);
          }
          if (this.pages.length > 0) this.activePageIndex = 0;
          
          return this.browser;
        } catch (e: any) {
          console.error(`[Browser] Failed to connect to ${this.browserURL}: ${e.message}. Falling back to launch.`);
          this.browserURL = null;
        }
      }

      // Priority 2: Try connecting to default debugging port (9222) automatically
      try {
        this.browser = await puppeteer.connect({
          browserURL: 'http://127.0.0.1:9222',
          defaultViewport: { width: 1280, height: 800 }
        });
        console.error('[Browser] Auto-connected to local Chrome at port 9222');
        this.pages = await this.browser.pages();
        for (const page of this.pages) await this.setupPage(page);
        if (this.pages.length > 0) this.activePageIndex = 0;
        return this.browser;
      } catch (e) {
        // Silent fail, proceed to launch
      }

      await this.killExistingBrowser();
      const args = [
        '--incognito',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--hide-scrollbars',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-features=IsolateOrigins,site-per-process',
        '--font-render-hinting=none',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--disable-infobars',
        '--window-position=0,0',
        '--ignore-certifcate-errors',
        '--ignore-certifcate-errors-spki-list',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ];
      if (this.proxy) args.push(`--proxy-server=${this.proxy}`);
      this.browser = await puppeteer.launch({
        headless: true,
        args,
        defaultViewport: { width: 1280, height: 800 }
      });
      
      const pid = this.browser.process()?.pid;
      if (pid) {
        if (!fs.existsSync(path.dirname(this.PID_FILE))) {
          fs.mkdirSync(path.dirname(this.PID_FILE), { recursive: true });
        }
        fs.writeFileSync(this.PID_FILE, pid.toString());
      }
    }
    this.resetIdleTimer();
    return this.browser;
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      if (this.browser) {
        console.error('Closing browser due to inactivity');
        await this.browser.close();
        this.browser = null;
        this.pages = [];
        this.activePageIndex = 0;
        this.networkRequests.clear();
        this.consoleMessages.clear();
      }
    }, 60 * 1000); // 1 minute idle timeout
  }

  private async getPage(index?: number): Promise<Page> {
    const browser = await this.getBrowser();
    const targetIndex = index !== undefined ? index : this.activePageIndex;

    if (this.pages.length === 0) {
      return await this.createNewPage();
    }

    if (targetIndex >= this.pages.length) {
        throw new Error(`Tab index ${targetIndex} out of bounds (total tabs: ${this.pages.length})`);
    }

    return this.pages[targetIndex];
  }

  private async createNewPage(): Promise<Page> {
    const browser = await this.getBrowser();
    while (this.pages.length >= this.MAX_TABS) {
      const oldestPage = this.pages[0];
      await oldestPage.close();
      // The 'close' event handler will remove it from this.pages
    }
    const page = await browser.newPage();
    await this.setupPage(page);
    this.pages.push(page);
    return page;
  }

  private async setupPage(page: Page) {
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(60000);

    const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    await page.setUserAgent(this.userAgent || defaultUA);
    
    this.consoleMessages.set(page, []);
    this.networkRequests.set(page, []);

    page.on('console', (msg: ConsoleMessage) => {
      const logs = this.consoleMessages.get(page) || [];
      logs.push({ type: msg.type(), text: msg.text(), timestamp: new Date().toISOString() });
      if (logs.length > 100) logs.shift();
    });

    page.on('request', (req: HTTPRequest) => {
      const reqs = this.networkRequests.get(page) || [];
      reqs.push({ method: req.method(), url: req.url(), resourceType: req.resourceType(), timestamp: new Date().toISOString() });
      if (reqs.length > 100) reqs.shift();
    });

    page.on('close', () => {
        this.consoleMessages.delete(page);
        this.networkRequests.delete(page);
        const idx = this.pages.indexOf(page);
        if (idx !== -1) {
            this.pages.splice(idx, 1);
            if (this.activePageIndex >= this.pages.length) {
                this.activePageIndex = Math.max(0, this.pages.length - 1);
            }
        }
    });
  }

  private async getAccessibilityTree(page: Page): Promise<string> {
    const tree = await page.evaluate(() => {
      let count = 1;
      const getRole = (el: HTMLElement): string => {
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

      const buildTree = (el: HTMLElement): any => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;

        // Viewport filtering: Check if element is within the current viewport
        const rect = el.getBoundingClientRect();
        const isInViewport = (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );

        // Only process if it's the body, or if it's visible in viewport
        // We still want to traverse children of non-visible elements because a small child might be visible
        // But for performance and token efficiency, we can mark them.
        
        const ref = 'e' + (count++);
        el.setAttribute('data-mcp-ref', ref);

        const node: any = {
          role: getRole(el),
          ref: ref,
          name: el.innerText?.split('\n')[0].substring(0, 60).trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '',
          visible: isInViewport
        };

        if (el instanceof HTMLAnchorElement) node.url = el.getAttribute('href');
        if (style.cursor === 'pointer') node.cursor = 'pointer';
        if (el.tagName.toLowerCase() === 'h1' || el.tagName.toLowerCase() === 'h2' || el.tagName.toLowerCase() === 'h3') {
            node.level = parseInt(el.tagName.substring(1));
        }

        const children = Array.from(el.children)
          .map(c => buildTree(c as HTMLElement))
          .filter(c => c !== null);
        
        if (children.length > 0) node.children = children;
        return node;
      };

      return buildTree(document.body);
    });

    const formatNode = (node: any, indent: string = ''): string => {
      // Skip non-visible elements to save tokens, unless they have visible children
      const visibleChildren = node.children?.filter((c: any) => c.visible || (c.children && c.children.length > 0));
      
      if (!node.visible && (!visibleChildren || visibleChildren.length === 0)) {
        return '';
      }

      let line = `${indent}- ${node.role}`;
      if (node.name) line += ` "${node.name}"`;
      if (node.level) line += ` [level=${node.level}]`;
      line += ` [ref=${node.ref}]`;
      if (node.cursor) line += ` [cursor=${node.cursor}]`;
      
      let extra = '';
      if (node.url) extra += `\n${indent}  - /url: ${node.url}`;

      if (visibleChildren && visibleChildren.length > 0) {
        const childrenStr = visibleChildren
          .map((c: any) => formatNode(c, indent + '  '))
          .filter((s: string) => s !== '')
          .join('\n');
        return childrenStr ? `${line}:${extra}\n${childrenStr}` : line + extra;
      }
      return line + extra;
    };

    return formatNode(tree);
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigates the active browser tab to a specific URL. Use this to load a webpage before performing other actions like taking snapshots or clicking elements. It waits for the "domcontentloaded" event by default.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The absolute URL to navigate to (e.g., https://example.com)' }
            },
            required: ['url']
          }
        },
        {
          name: 'browser_snapshot',
          description: 'Captures a structured, tree-like accessibility snapshot of the current page. This format is highly optimized for AI context windows, providing essential information like roles, names, and unique "ref" IDs (e.g., "ref:e12") for interactive elements. Use these "ref" IDs with the "browser_action" tool to interact with the page.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'browser_action',
          description: 'Performs an interaction on the current page. You can click, type, scroll, hover, or wait for specific elements. Elements can be targeted using standard CSS selectors or the unique "ref" IDs obtained from a "browser_snapshot".',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'type', 'scroll', 'press_key', 'hover', 'waitForSelector'],
                description: 'The type of interaction to perform.'
              },
              selector: {
                type: 'string',
                description: 'The target element. Can be a CSS selector or a reference ID from a snapshot (e.g., "ref:e12"). Required for click, type, hover, and waitForSelector.'
              },
              text: {
                type: 'string',
                description: 'The text to type into the element. Required for the "type" action.'
              },
              direction: {
                type: 'string',
                enum: ['up', 'down'],
                description: 'The direction to scroll. Required for the "scroll" action.'
              },
              key: {
                type: 'string',
                description: 'The keyboard key to press (e.g., "Enter", "ArrowLeft"). Required for the "press_key" action.'
              },
              timeout: {
                type: 'number',
                description: 'Maximum time to wait for the element to appear, in milliseconds (default: 30000).'
              }
            },
            required: ['action']
          }
        },
        {
          name: 'take_screenshot',
          description: 'Captures a full-page or viewport screenshot of the current page. Screenshots are saved locally and have a 5-day automatic cleanup lifecycle. Returns the local file path.',
          inputSchema: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Optional custom filename for the screenshot.' },
              fullPage: { type: 'boolean', description: 'Whether to capture the entire scrollable page (true) or just the visible viewport (false). Defaults to true.' },
              destinationFolder: { type: 'string', description: 'Optional custom directory path to save the screenshot. If not provided, defaults to the internal screenshots folder. Supports absolute or relative paths.' }
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
          name: 'browser_cookies',
          description: 'Manages browser cookies for the current session. Allows getting, setting, deleting, or clearing all cookies.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['get', 'set', 'delete', 'clear'],
                description: 'The cookie operation to perform.'
              },
              cookies: {
                type: 'array',
                items: { type: 'object' },
                description: 'An array of cookie objects to set or delete. Required for "set" and "delete" actions.'
              }
            },
            required: ['action']
          }
        },
        {
          name: 'browser_configure',
          description: 'Configures browser-wide settings such as Proxy, User-Agent, and Viewport dimensions. These settings apply to the entire browser instance.',
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
                },
                description: 'Custom viewport dimensions.'
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
              action: {
                type: 'string',
                enum: ['list', 'new', 'close', 'select'],
                description: 'The tab management action to perform.'
              },
              index: {
                type: 'number',
                description: 'The index of the tab to select or close. If omitted for "close", the active tab is closed.'
              }
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
              body: { type: ['object', 'string', 'null'], description: 'Optional request body.' },
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
              language: { type: 'string', description: 'Language code (e.g., "en", "id").' },
              region: { type: 'string', description: 'Country code (e.g., "US", "ID").' },
              site: { type: 'string', description: 'Restrict search to a specific domain (e.g., "wikipedia.org").' },
              dateRestrict: { type: 'string', description: 'Restrict results by date (e.g., "d1" for past day, "w1" for past week, "m1" for past month, "y1" for past year).' }
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
          name: 'batch_navigate',
          description: 'Navigates to multiple URLs simultaneously, each in its own new browser tab. This is much faster than sequential navigation for multi-source research.',
          inputSchema: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' }, description: 'An array of absolute URLs to open.' }
            },
            required: ['urls']
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
        },
        {
          name: 'browser_connect',
          description: 'Connects to an existing Chrome/Edge instance running with remote debugging enabled (e.g., --remote-debugging-port=9222). This allows the AI to use your existing login sessions and bypass CAPTCHAs manually.',
          inputSchema: {
            type: 'object',
            properties: {
              browserURL: {
                type: 'string',
                description: 'The URL of the remote debugging port (default: http://127.0.0.1:9222)',
                default: 'http://127.0.0.1:9222'
              }
            }
          }
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
        'browser_cookies',
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
        else if (toolName === 'browser_cookies') type = 'COOKIES';
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

        if (toolName === 'browser_connect') {
          const { browserURL } = args as any;
          this.browserURL = browserURL || 'http://127.0.0.1:9222';
          if (this.browser) {
            await this.browser.close();
            this.browser = null;
          }
          await this.getBrowser();
          return { content: [{ type: 'text', text: `Successfully connected to browser at ${this.browserURL}` }] };
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
        } else if (toolName === 'browser_cookies') {
          const { action, cookies } = args as any;
          if (action === 'get') return { content: [{ type: 'text', text: JSON.stringify(await page.cookies(), null, 2) }] };
          if (action === 'set') { await page.setCookie(...cookies); return { content: [{ type: 'text', text: 'OK' }] }; }
          if (action === 'clear') { const c = await page.cookies(); await page.deleteCookie(...c); return { content: [{ type: 'text', text: 'Cleared' }] }; }
          throw new Error('Invalid action');
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
