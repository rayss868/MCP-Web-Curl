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
import puppeteer from 'puppeteer';
import { fetchApi, FetchApiArgs, isValidFetchApiArgs } from './rest-client.js';
import { franc } from 'franc-min';
let translate: any;
(async () => {
  translate = (await import('translate')).default || (await import('translate'));
})();
import { Readability } from '@mozilla/readability';

// Define the interface for the fetch_webpage tool arguments
interface FetchWebpageArgs {
  url: string;
  blockResources?: boolean; // Keep existing for backward compatibility, or refine
  resourceTypesToBlock?: string[]; // More granular resource blocking
  timeout?: number;
  maxLength?: number; // For content extraction
  startIndex?: number; // For content extraction
  headers?: Record<string, string>; // Custom headers
  username?: string; // For basic authentication
  password?: string; // For basic authentication
}

// Validate the arguments for fetch_webpage tool
const isValidFetchWebpageArgs = (args: any): args is FetchWebpageArgs =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.url === 'string' &&
  (args.blockResources === undefined || typeof args.blockResources === 'boolean') &&
  (args.resourceTypesToBlock === undefined || (Array.isArray(args.resourceTypesToBlock) && args.resourceTypesToBlock.every((item: any) => typeof item === 'string'))) &&
  (args.timeout === undefined || typeof args.timeout === 'number') &&
  (args.maxLength === undefined || typeof args.maxLength === 'number') &&
  (args.startIndex === undefined || typeof args.startIndex === 'number') &&
  (args.headers === undefined || (typeof args.headers === 'object' && args.headers !== null && !Array.isArray(args.headers))) && // Check if it's an object, not an array
  (args.username === undefined || typeof args.username === 'string') &&
  (args.password === undefined || typeof args.password === 'string');

class WebCurlServer {
  private server: Server;

  constructor() {
    // Create startup log
    // try { // Removed logging
    //   const logsDir = path.join(process.cwd(), 'logs');
    //   if (!fs.existsSync(logsDir)) {
    //     fs.mkdirSync(logsDir);
    //   }
      
    //   fs.writeFileSync(
    //     path.join(logsDir, 'startup.log'),
    //     `[${new Date().toISOString()}] Web Curl MCP server starting\n`
    //   );
    // } catch (error) {
    //   console.error('Failed to create startup log:', error);
    // }
    
    this.server = new Server(
      {
        name: 'web-curl',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
      // try { // Removed logging
      //   const logsDir = path.join(process.cwd(), 'logs');
      //   if (!fs.existsSync(logsDir)) {
      //     fs.mkdirSync(logsDir);
      //   }
      //   fs.appendFileSync(
      //     path.join(logsDir, 'error.log'),
      //     `[${new Date().toISOString()}] MCP Error: ${error}\n`
      //   );
      // } catch (e) {
      //   console.error('Failed to log error:', e);
      // }
    };
    
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'fetch_webpage',
          description: 'Retrieve text content from a web page',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL of the webpage to fetch'
              },
              blockResources: {
                type: 'boolean',
                description: 'Whether to block images, stylesheets, and fonts to improve performance (default: true)'
              },
              resourceTypesToBlock: {
                type: 'array',
                items: {
                  type: 'string'
                },
                description: 'List of resource types to block (e.g., "image", "stylesheet", "font")'
              },
              timeout: {
                type: 'number',
                description: 'Navigation timeout in milliseconds (default: 60000)'
              },
              maxLength: {
                type: 'number',
                description: 'Maximum number of characters to return for content extraction (default: 2000 if not provided)'
              },
              startIndex: {
                type: 'number',
                description: 'Start character index for content extraction (default: 0)'
              },
              headers: {
                type: 'object',
                description: 'Custom headers to include in the request'
              },
              username: {
                type: 'string',
                description: 'Username for basic authentication'
              },
              password: {
                type: 'string',
                description: 'Password for basic authentication'
              },
              nextPageSelector: {
                type: 'string',
                description: 'CSS selector for next page button/link (for auto-pagination, optional)'
              },
              maxPages: {
                type: 'number',
                description: 'Maximum number of pages to crawl (for auto-pagination, optional, default: 1)'
              }
            },
            required: ['url'],
            additionalProperties: false,
          description: 'Fetch web content (text, html, mainContent, metadata, supports multi-page crawling). Debug option for verbose output/logging.'
          },
        },
        {
          name: 'fetch_api',
          description: 'Make a REST API request with various methods, headers, and body.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL for the API endpoint.',
              },
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
                description: 'HTTP method for the request.',
              },
              headers: {
                type: 'object',
                description: 'Request headers (e.g., for authorization).',
              },
              body: {
                type: ['object', 'string', 'null'], // Allow object, string, or null for body
                description: 'Request body (JSON object, string, etc.).',
              },
              timeout: {
                type: 'number',
                description: 'Request timeout in milliseconds (default: 60000).',
              },
            },
            required: ['url', 'method'],
            additionalProperties: false,
          description: 'HTTP API request (GET/POST/etc), custom header/body, timeout, debug mode for verbose output/logging.'
          },
        },
        {
          name: 'google_search',
          description: 'Search the web using Google Custom Search API. Requires google_search_config resource.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query'
              },
              num: {
                type: 'number',
                description: 'Number of results to return (1-10, optional)'
              },
              start: {
                type: 'number',
                description: 'Index of the first result to return (optional)'
              },
              language: {
                type: 'string',
                description: 'Restrict results to documents in this language (e.g. "lang_en", "lang_id")'
              },
              region: {
                type: 'string',
                description: 'Region code for search localization (e.g. "ID", "US")'
              },
              site: {
                type: 'string',
                description: 'Restrict results to a specific site/domain'
              },
              dateRestrict: {
                type: 'string',
                description: 'Restrict results to recent documents (e.g. "d1"=1 day, "w1"=1 week, "m1"=1 month, "y1"=1 year)'
              }
            },
            required: ['query'],
            additionalProperties: false,
          description: 'Google Custom Search API, supports advanced filters (language, region, site, dateRestrict), debug mode for verbose output/logging.'
          },
        },
        {
          name: 'smart_command',
          description: 'Free-form command: automatically fetch if a link is detected, automatically search if a search query is detected.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Free-form user instruction'
              }
            },
            required: ['command'],
            additionalProperties: false,
          description: 'Free-form command: auto fetch if link detected, auto search if query. Debug option for verbose output/logging.'
          }
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      if (toolName === 'fetch_webpage') {
        if (!isValidFetchWebpageArgs(args)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid fetch_webpage arguments'
          );
        }
        const url = args.url;
        const blockResources = args.blockResources ?? true;
        const resourceTypesToBlock = args.resourceTypesToBlock;
        const timeout = Math.min(args.timeout || 60000, 120000);
        const maxLength = args.maxLength !== undefined ? args.maxLength : 2000;
        const startIndex = args.startIndex || 0;
        const headers = args.headers;
        const username = args.username;
        const password = args.password;

        try {
          const result = await this.fetchWebpage(url, {
            blockResources,
            resourceTypesToBlock,
            timeout,
            maxLength,
            startIndex,
            headers,
            username,
            password
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          console.error('Error fetching webpage:', error);
          try {
            const logsDir = path.join(process.cwd(), 'logs');
            fs.appendFileSync(
              path.join(logsDir, 'error-log.txt'),
              `[${new Date().toISOString()}] Error during fetch_webpage "${url}": ${error}\n${error instanceof Error ? error.stack : ''}\n\n`
            );
          } catch (err) {
            console.error('Failed to log error:', err);
          }
          return {
            content: [
              {
                type: 'text',
                text: `Error fetching webpage: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
      } else if (toolName === 'fetch_api') {
        if (!isValidFetchApiArgs(args)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid fetch_api arguments'
          );
        }
        try {
          const result = await fetchApi(args as FetchApiArgs);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error: any) {
          console.error('Error calling fetch_api:', error);
           try {
            const logsDir = path.join(process.cwd(), 'logs');
            fs.appendFileSync(
              path.join(logsDir, 'error-log.txt'),
              `[${new Date().toISOString()}] Error during fetch_api "${args.url}": ${error}\n${error instanceof Error ? error.stack : ''}\n\n`
            );
          } catch (err) {
            console.error('Failed to log error:', err);
          }
          return {
            content: [
              {
                type: 'text',
                text: `Error calling API: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
      } else if (toolName === 'google_search') {
        // Validate google_search arguments
        const isValidGoogleSearchArgs = (a: any): boolean =>
          typeof a === 'object' &&
          a !== null &&
          typeof a.query === 'string' &&
          (a.num === undefined || (typeof a.num === 'number' && a.num >= 1 && a.num <= 10)) &&
          (a.start === undefined || typeof a.start === 'number');

        if (!isValidGoogleSearchArgs(args)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid google_search arguments'
          );
        }
        // Accept advanced arguments; apiKey/cx from resource
        const { query, num, start, language, region, site, dateRestrict } = args as {
          query: string;
          num?: number;
          start?: number;
          language?: string;
          region?: string;
          site?: string;
          dateRestrict?: string;
        };

        // Use config from resource
        const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
        const cx = process.env.CX_GOOGLE_SEARCH;
        if (!apiKey || !cx) {
          throw new McpError(ErrorCode.InvalidParams, 'Google Search API key and cx not set. Please set APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH in environment variable.');
        }

        let finalQuery = query;
        if (site) finalQuery += ` site:${site}`;
        const url = new URL('https://www.googleapis.com/customsearch/v1');
        url.searchParams.set('key', apiKey);
        url.searchParams.set('cx', cx);
        url.searchParams.set('q', finalQuery);
        if (num !== undefined) url.searchParams.set('num', String(num));
        if (start !== undefined) url.searchParams.set('start', String(start));
        if (language) url.searchParams.set('lr', language);
        if (region) url.searchParams.set('gl', region);
        if (dateRestrict) url.searchParams.set('dateRestrict', dateRestrict);

        try {
          const result = await fetchApi({
            url: url.toString(),
            method: 'GET',
            headers: {},
            timeout: 20000,
          });

          // Format only the relevant search results
          let formatted;
          if (result.ok && result.body && typeof result.body === 'object' && Array.isArray(result.body.items)) {
            formatted = result.body.items.map((item: any) => ({
              title: item.title,
              link: item.link,
              snippet: item.snippet,
              displayLink: item.displayLink,
            }));
          } else {
            formatted = result.body;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(formatted, null, 2),
              },
            ],
          };
        } catch (error: any) {
          console.error('Error calling google_search:', error);
          try {
            const logsDir = path.join(process.cwd(), 'logs');
            fs.appendFileSync(
              path.join(logsDir, 'error-log.txt'),
              `[${new Date().toISOString()}] Error during google_search: ${error}\n${error instanceof Error ? error.stack : ''}\n\n`
            );
          } catch (err) {
            console.error('Failed to log error:', err);
          }
          return {
            content: [
              {
                type: 'text',
                text: `Error calling google_search: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
      } else if (toolName === 'smart_command') {
        // Smart command: advanced language detection, translation, and query enrichment
        const { command } = args as { command: string };
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const fetchRegex = /\b(open|fetch|scrape|show|display|visit|go to)\b/i;

        const urlMatch = command.match(urlRegex);

        if (fetchRegex.test(command) && urlMatch) {
          // This is a fetch command
          try {
            const result = await this.fetchWebpage(urlMatch[0], {
              blockResources: true,
              timeout: 60000,
              startIndex: 0
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error: any) {
            return { content: [{ type: 'text', text: 'Gagal fetch: ' + error.message }], isError: true };
          }
        } else {
          // Otherwise, this is a search command
          // 1. Deteksi bahasa
          let detectedLang = franc(command);
          if (detectedLang === 'und') detectedLang = 'en';

          // 2. Translate to English if not already English
          let queryEn = command;
          if (detectedLang !== 'en') {
            try {
              queryEn = await translate(command, { to: 'en' });
            } catch (e) {
              // fallback: tetap pakai query asli
              queryEn = command;
            }
          }

          // 3. Query enrichment: add relevant keywords (simple, can be improved)
          let enrichedQuery = queryEn;
          if (!/news|latest|best|tips|how to|guide/i.test(enrichedQuery)) {
            enrichedQuery += ' best tips';
          }

          // 4. Logging enriched query
          let debugInfo = `Detected language: ${detectedLang}\nQuery (enriched): ${enrichedQuery}`;

          // 5. Search
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) {
            return { content: [{ type: 'text', text: 'Google Search API key and cx not set. Please set APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH in environment variable.' }], isError: true };
          }
          const url = new URL('https://www.googleapis.com/customsearch/v1');
          url.searchParams.set('key', apiKey);
          url.searchParams.set('cx', cx);
          url.searchParams.set('q', enrichedQuery);
          try {
            const result = await fetchApi({
              url: url.toString(),
              method: 'GET',
              headers: {},
              timeout: 20000,
            });
            let formatted;
            if (result.ok && result.body && typeof result.body === 'object' && Array.isArray(result.body.items)) {
              formatted = result.body.items.map((item: any) => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
                displayLink: item.displayLink,
              }));
            } else {
              formatted = result.body;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: debugInfo + '\n\n' + JSON.stringify(formatted, null, 2),
                },
              ],
            };
          } catch (error: any) {
            return { content: [{ type: 'text', text: 'Gagal search: ' + error.message }], isError: true };
          }
        }
      } else {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${toolName}`
        );
      }
      // Fallback to ensure a valid return type
      // (should never reach here, but for type safety)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { content: [{ type: 'text', text: 'Unknown error.' }], isError: true } as any;
    });
  }

  private async fetchWebpage(url: string, options: {
    blockResources: boolean;
    resourceTypesToBlock?: string[];
    timeout: number;
    maxLength?: number;
    startIndex: number;
    headers?: Record<string, string>;
    username?: string;
    password?: string;
    nextPageSelector?: string;
    maxPages?: number;
  }) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          '--incognito',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });

      try {
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(options.timeout);

        // Set custom headers
        if (options.headers) {
          await page.setExtraHTTPHeaders(options.headers);
        }

        // Set basic authentication
        if (options.username && options.password) {
          await page.authenticate({
            username: options.username,
            password: options.password
          });
        }

        // Block unnecessary resources if requested
        if (options.blockResources || options.resourceTypesToBlock) {
          await page.setRequestInterception(true);
          page.on('request', req => {
            const resourceType = req.resourceType();
            const shouldBlock = options.resourceTypesToBlock
              ? options.resourceTypesToBlock.includes(resourceType)
              : options.blockResources && ['image', 'stylesheet', 'font'].includes(resourceType);

            shouldBlock ? req.abort() : req.continue();
          });
        }

        // Multi-page crawling logic
        const results: any[] = [];
        let currentPage = 1;
        let currentUrl = url;
        let hasNext = true;

        while (hasNext && currentPage <= (options.maxPages || 1)) {
          console.error(`Fetching content from: ${currentUrl} (page ${currentPage})`);
          await page.goto(currentUrl, {
            waitUntil: 'networkidle0',
            timeout: options.timeout
          });

          const title = await page.title();
          const html = await page.content();

          // Use Readability for main article extraction (Node-side)
          let mainContent = null;
          try {
            const { JSDOM } = await import('jsdom');
            const dom = new JSDOM(html, { url: currentUrl });
            const reader = new Readability(dom.window.document);
            mainContent = reader.parse();
          } catch (e) {
            mainContent = null;
          }

          let textContent = await page.evaluate(() => document.body.textContent?.trim() || '');
          let textContentTruncated = false;
          if (options.maxLength !== undefined && textContent.length > options.maxLength) {
            textContent = textContent.substring(0, options.maxLength);
            textContentTruncated = true;
          }
          textContent = textContent.substring(options.startIndex);
          if (options.maxLength !== undefined) {
            textContent = textContent.substring(0, options.maxLength);
          }

          const metadata = await page.evaluate(() => {
            const metaTags: Record<string, string> = {};
            document.querySelectorAll('meta').forEach(meta => {
              const name = meta.getAttribute('name') || meta.getAttribute('property');
              const content = meta.getAttribute('content');
              if (name && content) {
                metaTags[name] = content;
              }
            });
            return metaTags;
          });

          results.push({
            url: currentUrl,
            title,
            metadata,
            html,
            mainContent,
            textContent,
            textContentTruncated,
            fetchedAt: new Date().toISOString(),
            info: textContentTruncated
              ? (() => {
                  const startIndex = typeof options.startIndex === "number" ? options.startIndex : 0;
                  const maxLength = typeof options.maxLength === "number" ? options.maxLength : textContent.length;
                  return "Result truncated. To read more, call fetch_webpage again with startIndex set to " + (startIndex + maxLength) + " and the same maxLength.";
                })()
              : undefined
          });

          // Pagination: find next page if selector is provided
          if (options.nextPageSelector) {
            const nextHref = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              if (el.tagName === 'A' && el.hasAttribute('href')) {
                return (el as HTMLAnchorElement).href;
              }
              // Try clicking if not an <a> element
              el.scrollIntoView();
              (el as HTMLElement).click();
              return null;
            }, options.nextPageSelector);

            if (nextHref && typeof nextHref === 'string' && nextHref !== currentUrl) {
              currentUrl = nextHref;
              currentPage++;
            } else {
              hasNext = false;
            }
          } else {
            hasNext = false;
          }
        }

        // If only 1 page, return single object; if multi-page, return array
        return results.length === 1 ? results[0] : results;
      } finally {
        await browser.close();
      }
    } catch (error) {
      console.error('Webpage fetch error:', error);
      throw error;
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web-curl MCP server running on stdio');
  }
}

const server = new WebCurlServer();
server.run().catch(console.error);
