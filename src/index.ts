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
const { PDFParse } = require('pdf-parse');
import mammoth from 'mammoth';
import { fetchApi, fetchWebFallback, FetchApiArgs, isValidFetchApiArgs } from './rest-client.js';
import { runExtract } from './extract.js';
import { runCrawl } from './crawl.js';
import { runResearch } from './research.js';
import { runAgent } from './agent.js';
import { googleSearch } from './search.js';

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
          // On Windows, use taskkill to terminate the full process tree.
          if (process.platform === 'win32') {
            try {
              require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            } catch (e) {}
          } else {
            try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (e) {}
          }
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
    await this.getBrowser();
    const idx = index !== undefined ? index : this.activePageIndex;

    if (!this.pages[idx]) {
      // If the requested tab index doesn't exist (e.g., first use or stale index),
      // create a new page and make it the active tab.
      const page = await this.createNewPage();
      this.activePageIndex = this.pages.length - 1;
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
        // Expose only a small, agent-friendly surface to reduce tool-chaining.
        // Lower-level tools still exist in CallToolRequestSchema for manual/debug usage.
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
              timeout: { type: 'number', description: 'Request timeout in milliseconds (default 60000).' },
              redirect: { type: 'string', enum: ['follow', 'error', 'manual'], description: 'Redirect handling mode (default follow).' },
              limit: { type: 'number', description: 'Maximum number of characters to return from the response body.' }
            },
            required: ['url', 'method', 'limit']
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
          description: 'Executes multiple search queries in parallel using the configured External API. Returns a combined list of results for each query.',
          inputSchema: {
            type: 'object',
            properties: {
              queries: { type: 'array', items: { type: 'string' }, description: 'An array of search query strings.' }
            },
            required: ['queries']
          }
        },
        {
          name: 'research',
          description:
            'Research pipeline: decomposes a question into sub-queries, runs them in parallel via search, dedupes results, fetches the top sources (with external API fallback on blocks/errors), and produces a markdown report with numbered citations plus the real content of each fetched source. Use for multi-faceted questions.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The research question.' },
              maxSubQueries: { type: 'number', description: 'Max sub-queries to decompose into (default 4).' },
              maxResultsPerQuery: { type: 'number', description: 'Results to keep per sub-query (default 5).' },
              fetchSources: {
                type: 'number',
                description:
                  'How many top sources to fetch and include their real content (range 5-10, default 5; 10 recommended for deeper reports).',
              },
              language: { type: 'string', description: 'Optional language code, e.g. id or en.' },
              site: { type: 'string', description: 'Optional site restriction (e.g. wikipedia.org).' },
              dateRestrict: { type: 'string', description: 'Optional freshness filter, e.g. d1, m6, y1.' }
            },
            required: ['query']
          }
        },
        {
          name: 'extract',
          description:
            'Extract structured content from a page: CSS-selector fields, tables, meta tags, JSON-LD blocks, Readability main content, and detected schema types (og:type / JSON-LD @type). Non-HTML responses (text, JSON, source files) are returned as raw text in mainContent instead of failing.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The page URL.' },
              selectors: {
                type: 'array',
                description: 'Optional CSS selector fields to extract.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name in the output.' },
                    css: { type: 'string', description: 'CSS selector, e.g. h1, .price, #author.' },
                    attr: { type: 'string', description: 'Optional attribute to read (e.g. href, src, content). Defaults to text content.' },
                    all: { type: 'boolean', description: 'If true, return all matches as an array (default false).' }
                  },
                  required: ['name', 'css']
                }
              },
              includeTables: { type: 'boolean', description: 'Extract tables as row arrays (default true).' },
              includeJsonLd: { type: 'boolean', description: 'Parse JSON-LD blocks (default true).' },
              includeMeta: { type: 'boolean', description: 'Collect meta tags (default true).' },
              includeMainContent: { type: 'boolean', description: 'Extract main text via Readability (default true).' },
              maxTextChars: { type: 'number', description: 'Cap for main content characters (default 20000).' }
            },
            required: ['url']
          }
        },
        {
          name: 'crawl',
          description:
            'Crawl a site: BFS or DFS traversal, sitemap parsing, or a one-page link map. Supports include/exclude regex filters, same-domain restriction, max pages, depth, and a politeness delay.',
          inputSchema: {
            type: 'object',
            properties: {
              startUrl: { type: 'string', description: 'The seed URL (or sitemap URL for strategy=sitemap).' },
              strategy: { type: 'string', enum: ['bfs', 'dfs', 'sitemap', 'map'], description: 'Traversal strategy (default bfs).' },
              maxPages: { type: 'number', description: 'Max pages to visit (default 20).' },
              include: { type: 'array', items: { type: 'string' }, description: 'Regex patterns; if set, only URLs matching at least one are kept.' },
              exclude: { type: 'array', items: { type: 'string' }, description: 'Regex patterns; URLs matching any are dropped.' },
              sameDomain: { type: 'boolean', description: 'Restrict to the start host (default true).' },
              delayMs: { type: 'number', description: 'Politeness delay between requests (default 250).' },
              timeoutMs: { type: 'number', description: 'Per-page fetch timeout (default 30000).' },
              maxDepth: { type: 'number', description: 'Max link depth (default 3).' }
            },
            required: ['startUrl']
          }
        },
        {
          name: 'agent',
          description:
            'Structured data collection: given explicit URLs (or a search query to discover them) plus a field schema (CSS selectors and/or JSON-LD paths), reads each page and returns flat records. Ideal for building tables of data from many pages.',
          inputSchema: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' }, description: 'Explicit URLs to process (optional if query given).' },
              query: { type: 'string', description: 'Search query used to discover URLs when urls is empty.' },
              maxUrls: { type: 'number', description: 'Max URLs to process when using query (default 5).' },
              fields: {
                type: 'array',
                description: 'The output schema: one entry per field.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name.' },
                    selector: { type: 'string', description: 'CSS selector to read the value.' },
                    attr: { type: 'string', description: 'Optional attribute instead of text.' },
                    jsonLdPath: { type: 'string', description: 'Optional dotted path into the JSON-LD graph, e.g. 0.offers.price.' },
                    type: { type: 'string', enum: ['text', 'number', 'boolean', 'url'], description: 'Value type coercion (default text).' },
                    required: { type: 'boolean', description: 'Fail the record if the field is missing (default false).' }
                  },
                  required: ['name']
                }
              }
            },
            required: ['fields']
          }
        },
        {
          name: 'browser_close',
          description: 'Immediately terminates the browser process and closes all open tabs. Note: the browser also auto-closes after 15 minutes of inactivity.',
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

        // Only browser-specific low-level tools need an active Page.
        // Non-browser tools (API, search, document, download) must not launch Chromium.
        // batch_navigate manages its own page lifecycle internally.
        const pageTools = new Set([
          'browser_navigate', 'browser_snapshot', 'browser_action', 'take_screenshot',
          'browser_network_requests', 'browser_console_messages', 'browser_links'
        ]);
        const page: Page = pageTools.has(toolName) ? await this.getPage() : (null as any);
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
          const searchResults = await Promise.all(queries.map(async (query: string) => ({
            query,
            results: await googleSearch(query),
          })));
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
          if (!res.ok) throw new Error(`Failed to fetch document: ${res.status} ${res.statusText}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const contentType = (res.headers.get('content-type') || '').toLowerCase();
          const pathname = new URL(url).pathname.toLowerCase();

          if (contentType.includes('pdf') || pathname.endsWith('.pdf')) {
            const parser = new PDFParse({ data: buffer });
            try {
              const data = await parser.getText();
              return { content: [{ type: 'text', text: data.text }] };
            } finally {
              await parser.destroy();
            }
          }

          if (contentType.includes('wordprocessingml') || pathname.endsWith('.docx')) {
            const data = await mammoth.extractRawText({ buffer });
            return { content: [{ type: 'text', text: data.value }] };
          }

          throw new Error('Unsupported document type. Only PDF and DOCX are supported.');
        } else if (toolName === 'fetch_api') {
          if (!isValidFetchApiArgs(args)) throw new Error('Invalid args');
          return { content: [{ type: 'text', text: JSON.stringify(await fetchApi(args as any), null, 2) }] };
        } else if (toolName === 'google_search') {
          const { query, num, start, language, region, site, dateRestrict } = args as any;
          const results = await googleSearch(query, { num, start, language, region, site, dateRestrict });
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

          const results = await googleSearch(query);

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

          // Direct fetch first with a hard timeout; on any failure (blocked
          // 429/403, 5xx, network error, timeout) fall back to the external
          // fetch API — same policy as extract/crawl/fetch_api.
          const timeoutMs = 60000;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let response: Response;
          let viaFallback = false;
          try {
            response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
          } catch (directError: any) {
            clearTimeout(timer);
            try {
              response = await fetchWebFallback(url, timeoutMs);
              viaFallback = true;
            } catch (fallbackError: any) {
              throw new Error(
                `Failed to fetch file (${directError?.message || directError}); API fallback failed (${fallbackError?.message || fallbackError})`
              );
            }
          }
          clearTimeout(timer);

          const finalFilename = filename || path.basename(new URL(url).pathname) || 'downloaded_file';
          const filePath = path.join(destPath, finalFilename);

          const fileStream = fs.createWriteStream(filePath);
          await pipeline(Readable.fromWeb(response.body as any), fileStream);

          const note = viaFallback
            ? ' (via API fallback — content is markdown/text, not raw HTML)'
            : '';
          return { content: [{ type: 'text', text: `File downloaded to: ${filePath}${note}` }] };
        } else if (toolName === 'research') {
          const result = await runResearch(args as any);
          return { content: [{ type: 'text', text: result.report }] };
        } else if (toolName === 'extract') {
          const result = await runExtract(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } else if (toolName === 'crawl') {
          const result = await runCrawl(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } else if (toolName === 'agent') {
          const result = await runAgent(args as any);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
