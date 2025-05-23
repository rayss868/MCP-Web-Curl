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
                description: 'Maximum number of characters to return for content extraction'
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
              }
            },
            required: ['url']
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
              }
            },
            required: ['query']
          },
        },
        {
          name: 'smart_command',
          description: 'Perintah bebas: otomatis fetch jika ada link, otomatis search jika ada kata "cari di internet".',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Instruksi bebas dari user'
              }
            },
            required: ['command']
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
        const maxLength = args.maxLength;
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
        // Only accept query, num, start as arguments; apiKey/cx from resource
        const { query, num, start } = args as {
          query: string;
          num?: number;
          start?: number;
        };

        // Use config from resource
        const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
        const cx = process.env.CX_GOOGLE_SEARCH;
        if (!apiKey || !cx) {
          throw new McpError(ErrorCode.InvalidParams, 'Google Search API key and cx not set. Please set APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH in environment variable.');
        }

        const url = new URL('https://www.googleapis.com/customsearch/v1');
        url.searchParams.set('key', apiKey);
        url.searchParams.set('cx', cx);
        url.searchParams.set('q', query);
        if (num !== undefined) url.searchParams.set('num', String(num));
        if (start !== undefined) url.searchParams.set('start', String(start));

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
        // Smart command: simple pattern matching
        const { command } = args as { command: string };
        // Enhanced regex for both Indonesian and English commands
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const fetchRegex = /\b(buka|lihat|open|fetch|scrape|ambil|tampilkan|show|display|visit|go to|perlihatkan)\b.*(https?:\/\/[^\s]+)/i;
        const searchRegex = /\b(cari|temukan|search|find|look up|googling|info|informasi|information|what is|apa itu|siapa|where is|kenapa|mengapa|how to|bagaimana|explain|jelaskan|definition|definisi)\b/i;

        if (fetchRegex.test(command) || urlRegex.test(command)) {
          // Extract first URL and call fetch_webpage
          const urlMatch = command.match(urlRegex);
          if (urlMatch && urlMatch[0]) {
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
          }
        } else if (searchRegex.test(command)) {
          // Try to extract query after search keyword
          let query = command;
          const searchMatch = command.match(searchRegex);
          if (searchMatch) {
            query = command.replace(searchRegex, '').trim();
          }
          if (!query) query = 'contoh'; // fallback
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) {
            return { content: [{ type: 'text', text: 'Google Search API key and cx not set. Please set APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH in environment variable.' }], isError: true };
          }
          const url = new URL('https://www.googleapis.com/customsearch/v1');
          url.searchParams.set('key', apiKey);
          url.searchParams.set('cx', cx);
          url.searchParams.set('q', query);
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
                  text: JSON.stringify(formatted, null, 2),
                },
              ],
            };
          } catch (error: any) {
            return { content: [{ type: 'text', text: 'Gagal search: ' + error.message }], isError: true };
          }
        } else {
          return {
            content: [
              {
                type: 'text',
                text: 'Tidak ada URL atau perintah pencarian (dalam bahasa Indonesia atau Inggris) yang terdeteksi pada instruksi.'
              }
            ],
            isError: true
          };
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
  }) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
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


        // Navigate and wait for content
        console.error(`Fetching content from: ${url}`);
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: options.timeout
        });

        // Extract page content and metadata
        const title = await page.title();
        let textContent = await page.evaluate(() => document.body.textContent?.trim() || ''); // Rename variable for clarity
        
        // Limit text content length if maxLength is set
        let textContentTruncated = false;
        if (options.maxLength !== undefined && textContent.length > options.maxLength) {
          textContent = textContent.substring(0, options.maxLength);
          textContentTruncated = true;
        }
        
        // Apply startIndex and maxLength for text content extraction
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
        
        // Create result object
        return {
          url,
          title,
          metadata,
          textContent,
          textContentTruncated, // True if textContent was truncated due to maxLength
          fetchedAt: new Date().toISOString(),
          info: textContentTruncated
            ? (() => {
                const startIndex = typeof options.startIndex === "number" ? options.startIndex : 0;
                const maxLength = typeof options.maxLength === "number" ? options.maxLength : textContent.length;
                return "Result truncated. To read more, call fetch_webpage again with startIndex set to " + (startIndex + maxLength) + " and the same maxLength.";
              })()
            : undefined
        };
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