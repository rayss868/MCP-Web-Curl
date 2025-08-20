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
import { franc } from 'franc-min';
import { Readable } from 'stream'; // Import Readable for Node.js stream
import { pipeline } from 'node:stream/promises'; // Import pipeline for robust stream handling
let translate: any;
(async () => {
  translate = (await import('translate')).default || (await import('translate'));
})();
import { Readability } from '@mozilla/readability';

 // Define the interface for the fetch_webpage tool arguments
 interface FetchWebpageArgs {
   url: string;
   blockResources?: boolean;
   resourceTypesToBlock?: string[];
   timeout?: number;
   maxLength?: number;
  startIndex?: number;
  nextPageSelector?: string;
  maxPages?: number;
  headers?: Record<string, string>;
  username?: string;
  password?: string;
 }

// Define the interface for the download_file tool arguments
interface DownloadFileArgs {
  url: string;
  destinationFolder: string;
}

// Validate the arguments for download_file tool
const isValidDownloadFileArgs = (args: any): args is DownloadFileArgs => {
  if (
    typeof args === 'object' &&
    args !== null &&
    typeof args.url === 'string' &&
    typeof args.destinationFolder === 'string'
  ) {
    // Accept relative paths; resolution is handled in downloadFile (resolved against process.cwd())
    return true;
  }
  return false;
};

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
  (args.headers === undefined || (typeof args.headers === 'object' && args.headers !== null && !Array.isArray(args.headers))) &&
  (args.username === undefined || typeof args.username === 'string') &&
  (args.password === undefined || typeof args.password === 'string');

class WebCurlServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'web-curl',
        version: '1.0.5',
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
    };

    // Logging to disk is disabled

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
                description: 'Navigation timeout in milliseconds (default: 120000)'
              },
              maxLength: {
                type: 'number',
                description: 'Maximum number of characters to return (default: 10000).'
              },
              startIndex: {
                type: 'number',
                description: 'Start character index for content extraction (required; default: 0).'
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
              },
            },
            required: ['url', 'startIndex'],
            additionalProperties: false,
            description: 'Fetch web content (text, html, mainContent, metadata, supports multi-page crawling, and AI-friendly regex extraction). Debug option for verbose output/logging.'
          },
        },
        {
          name: 'fetch_api',
          description: 'Make a REST API request with various methods, headers, and body.',
          autoApprove: true,
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
              limit: {
                type: 'number',
                description: 'Maximum number of characters to return in the response body (required).'
              },
            },
            required: ['url', 'method', 'limit'],
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
                description: 'Search query, including any operators like site:, filetype:, etc.'
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
            required: ['query'],
            additionalProperties: false,
            description: 'Search the web using Google Custom Search API.'
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
        {
          name: 'download_file',
          description: 'Download a file from a given URL to a specified folder.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The URL of the file to download.'
              },
              destinationFolder: {
                type: 'string',
                description: 'The destination folder (relative to the workspace directory) to save the file.'
              }
            },
            required: ['url', 'destinationFolder'],
            additionalProperties: false,
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      if (toolName === 'fetch_webpage') {
        // Cast args to a more specific type after validation
        if (!isValidFetchWebpageArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, 'Invalid fetch_webpage arguments');
        }

        // Map legacy/alias params to current names:
        // - 'index' -> startIndex
        try {
          if (typeof (args as any).index === 'number' && typeof (args as any).startIndex !== 'number') {
            (args as any).startIndex = (args as any).index;
          }
        } catch (e) {
          // ignore mapping errors; validation below will catch invalid shapes
        }

        // Enforce required parameters (runtime validation).
        const hasStartIndex = typeof (args as any).startIndex === 'number';
        const hasMaxLength = typeof (args as any).maxLength === 'number';

        if (!hasStartIndex) {
          throw new McpError(ErrorCode.InvalidParams, "fetch_webpage: required parameter 'startIndex' (or alias 'index') is missing or not a number");
        }
        if (!hasMaxLength) {
          throw new McpError(ErrorCode.InvalidParams, "fetch_webpage: required parameter 'maxLength' is missing or not a number");
        }

        const validatedArgs = args as FetchWebpageArgs & {
            nextPageSelector?: string;
            maxPages?: number;
        };

        const {
            url,
            blockResources = false,
            resourceTypesToBlock,
            timeout: rawTimeout,
            maxLength = 4000,
            startIndex = 0,
            headers,
            username,
            password,
            nextPageSelector,
            maxPages = 1
        } = validatedArgs;

        const timeout = Math.min(rawTimeout || 60000, 300000);

        // Helper function to perform the fetch and process the result
        const performFetchAndProcess = async (currentArgs: typeof validatedArgs) => {
            const result: any = await this.fetchWebpage(currentArgs.url, {
                blockResources: currentArgs.blockResources ?? false, // Provide default
                resourceTypesToBlock: currentArgs.resourceTypesToBlock,
                timeout: currentArgs.timeout ?? 30000, // Provide default
                maxLength: currentArgs.maxLength ?? 4000, // Provide default
                startIndex: currentArgs.startIndex ?? 0, // Provide default
                headers: currentArgs.headers,
                username: currentArgs.username,
                password: currentArgs.password,
                nextPageSelector: currentArgs.nextPageSelector,
                maxPages: currentArgs.maxPages ?? 1, // Provide default
            });

            const totalCharacters = result.contentLength; // total characters of the whitespace-removed HTML
            const slicedContentLength = result.content.length; // length of the sliced part

            const remainingCharacters = Math.max(0, totalCharacters - (currentArgs.startIndex + slicedContentLength));
            const nextStartIndex = currentArgs.startIndex + slicedContentLength; // The next start index should be right after the current sliced content

            const instruction = remainingCharacters === 0
                ? "All content has been fetched."
                : `To fetch more content, call fetch_webpage again with startIndex=${nextStartIndex}. If you have enough information, you can stop.`;

            const finalResponse = {
                url: result.url,
                title: result.title,
                content: result.content, // This is the sliced, whitespace-removed HTML
                fetchedAt: result.fetchedAt,
                startIndex: currentArgs.startIndex,
                maxLength: currentArgs.maxLength,
                remainingCharacters: remainingCharacters,
                instruction: instruction,
            };

            return {
                content: [{ type: 'text', text: JSON.stringify(finalResponse, null, 2) }],
            };
        };

        try {
            return await performFetchAndProcess(validatedArgs);
        } catch (error: any) { // Catch block for fetch_webpage
            let errorMessage = `Error fetching webpage: ${error.message}`;

            // Check for timeout error and suggest disabling blockResources
            // Removed automatic retry logic as blockResources is now always false.
            // The default behavior is now to not block resources.

            // If still a timeout, you might consider a generic message or further options.
            // For now, it will just return the original error message.

            // Note: The previous logic for suggesting 'blockResources: false' is removed
            // because blockResources is now forced to false by default for all calls.

            console.error('Error fetching webpage:', error);
            return {
                content: [{ type: 'text', text: `Error fetching webpage: ${errorMessage}` }],
                isError: true,
            };
        }
      } else if (toolName === 'fetch_api') {
        // Define an interface for fetch_api arguments directly here
        interface DirectFetchApiArgs {
          url: string;
          method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
          headers?: Record<string, string>;
          body?: any;
          timeout?: number;
          limit: number;
        }

        const isValidDirectFetchApiArgs = (a: any): a is DirectFetchApiArgs => {
          return (
            typeof a === 'object' &&
            a !== null &&
            typeof a.url === 'string' &&
            ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(a.method) &&
            (a.headers === undefined || (typeof a.headers === 'object' && a.headers !== null && !Array.isArray(a.headers))) &&
            (a.timeout === undefined || typeof a.timeout === 'number') &&
            (typeof a.limit === 'number')
          );
        };

        if (!isValidDirectFetchApiArgs(args)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid fetch_api arguments'
          );
        }

        const { url, method, headers, body, timeout = 60000, limit } = args as DirectFetchApiArgs;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          let options: RequestInit = {
            method,
            headers,
            signal: controller.signal,
          };

          if (body !== undefined && body !== null) {
            options = {
              ...options,
              body: (typeof body === 'object' && headers && headers['Content-Type'] === 'application/json') ? JSON.stringify(body) : body
            };
          }

          const response = await fetch(url, options as any);
          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          let responseBody: any;
          const contentType = response.headers.get('content-type');

          if (contentType && contentType.includes('application/json')) {
            responseBody = await response.json();
          } else if (contentType && (contentType.includes('text/') || contentType.includes('application/xml') || contentType.includes('application/xhtml+xml'))) {
            responseBody = await response.text();
          } else {
            try {
              const buffer = await response.arrayBuffer();
              responseBody = Buffer.from(buffer).toString('base64');
            } catch (e) {
              responseBody = 'Could not parse body (binary or unknown content type)';
            }
          }

          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            responseHeaders[name] = value;
          });

          let fullBodyString: string;
          try {
            if (typeof responseBody === 'string') {
              fullBodyString = responseBody;
            } else {
              fullBodyString = JSON.stringify(responseBody);
            }
          } catch (e) {
            fullBodyString = String(responseBody);
          }

          const bodyLength = fullBodyString.length;
          let truncated = false;
          let finalBody: any = responseBody;

          if (typeof limit === 'number' && bodyLength > limit) {
            finalBody = fullBodyString.substring(0, limit);
            truncated = true;
          } else {
            finalBody = responseBody;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: response.status,
                  statusText: response.statusText,
                  headers: responseHeaders,
                  body: finalBody,
                  ok: response.ok,
                  url: response.url,
                  bodyLength,
                  truncated,
                }, null, 2),
              },
            ],
          };
        } catch (error: any) {
          clearTimeout(timeoutId);
          if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout / 1000} seconds`);
          }
          console.error('Error calling fetch_api:', error);
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
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); // Apply timeout manually

            const response = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json'
              },
              signal: controller.signal // Use abort signal for timeout
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json(); // Parse JSON directly

            let formatted;
            if (data && Array.isArray(data.items)) {
              formatted = data.items.map((item: any) => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
              }));
            } else {
              formatted = data; // Fallback to full data if items not found
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
              blockResources: false, // Force blockResources to be false
              timeout: 60000,
              maxLength: 4000,
              startIndex: 0,
              maxPages: 1,
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
          const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
          const cx = process.env.CX_GOOGLE_SEARCH;
          if (!apiKey || !cx) {
            return { content: [{ type: 'text', text: 'Google Search API key and cx not set. Please set APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH in environment variable.' }], isError: true };
          }
          const url = new URL('https://www.googleapis.com/customsearch/v1');
          url.searchParams.set('key', apiKey);
          url.searchParams.set('cx', cx);
          url.searchParams.set('q', command);
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); // Apply timeout manually

            const response = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json'
              },
              signal: controller.signal // Use abort signal for timeout
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json(); // Parse JSON directly

            let formatted;
            if (data && Array.isArray(data.items)) {
              formatted = data.items.map((item: any) => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
              }));
            } else {
              formatted = data; // Fallback to full data if items not found
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
            console.error('Error during Google Search:', error);
            return { content: [{ type: 'text', text: 'Error during Google Search: ' + error.message }], isError: true };
          }
        }
      } else if (toolName === 'download_file') {
        if (!isValidDownloadFileArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid download_file arguments');
        }
        const validatedArgs = args as DownloadFileArgs;
        try {
          const filePath = await this.downloadFile(validatedArgs.url, validatedArgs.destinationFolder);
          return {
            content: [{ type: 'text', text: `File downloaded successfully to: ${filePath}` }],
          };
        } catch (error: any) {
          console.error('Error calling download_file:', error);
          return {
            content: [{ type: 'text', text: `Error downloading file: ${error.message}` }],
            isError: true,
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
      maxLength: number;
      startIndex: number;
      headers?: Record<string, string>;
      username?: string;
      password?: string;
      nextPageSelector?: string;
      maxPages: number;
  }) {
      const browser = await puppeteer.launch({
          headless: true,
          args: ['--incognito', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });

      let page;
      try {
          page = await browser.newPage();
          await page.setDefaultNavigationTimeout(options.timeout);

          if (options.headers) {
              await page.setExtraHTTPHeaders(options.headers);
          }

          if (options.username && options.password) {
              await page.authenticate({ username: options.username, password: options.password });
          }

          if (options.blockResources || options.resourceTypesToBlock) {
              await page.setRequestInterception(true);
              page.on('request', req => {
                  const resourceType = req.resourceType();
                  const typesToBlock = options.resourceTypesToBlock ?? [];
                  if (typesToBlock.includes(resourceType)) {
                      req.abort();
                  } else {
                      req.continue();
                  }
              });
          }

          const results: any[] = [];
          let currentUrl = url;
          let currentPageNum = 1;

          while (currentPageNum <= options.maxPages) {
              console.error(`Fetching content from: ${currentUrl} (page ${currentPageNum})`);
              await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout });

              const title = await page.title();

              // Efficiently extract and slice content within the browser context
              // 1. Get the full content from the page
              const html = await page.content();

              // Step 1: Remove all whitespace from the raw HTML content
              const cleanedHtml = html.replace(/\s/g, '');

              // Step 2: Calculate the total character count of the cleaned HTML
              const totalLength = cleanedHtml.length;

              // Step 3: Slice the cleaned HTML based on startIndex and maxLength
              const slicedContent = cleanedHtml.substring(options.startIndex, options.startIndex + options.maxLength);

              results.push({
                  url: currentUrl,
                  title,
                  content: slicedContent, // Renamed from slicedContent for consistency with tool handler
                  contentLength: totalLength, // Renamed from totalCharacters for consistency with tool handler
                  fetchedAt: new Date().toISOString(),
              });
              console.log(`DEBUG: totalLength (after whitespace removal): ${totalLength}, startIndex: ${options.startIndex}, slicedContent length: ${slicedContent.length}`);
              
              if (!options.nextPageSelector || currentPageNum >= options.maxPages) {
                  break;
              }

              // Pagination logic
              const nextHref = await page.evaluate((sel) => {
                  const el = document.querySelector(sel) as HTMLAnchorElement | HTMLElement;
                  if (el) {
                      if ('href' in el && (el as HTMLAnchorElement).href) {
                          return (el as HTMLAnchorElement).href;
                      }
                      el.click(); // Fallback for non-anchor elements
                  }
                  return null;
              }, options.nextPageSelector);

              if (nextHref && nextHref !== currentUrl) {
                  currentUrl = nextHref;
                  currentPageNum++;
              } else {
                  break; // No more pages
              }
          }

          return results.length === 1 ? results[0] : results;
      } catch (err) {
          throw err;
      } finally {
          // Always close browser to prevent temp file leaks
          if (browser) {
            try { await browser.close(); } catch (e) {}
          }
      }
  }

  private async downloadFile(url: string, destinationFolder: string): Promise<string> {
    const logsDir = path.join(process.cwd(), 'logs');
    try {
      // Ensure the destination folder exists
      const fullDestinationPath = path.resolve(process.cwd(), destinationFolder);
      if (!fs.existsSync(fullDestinationPath)) {
        fs.mkdirSync(fullDestinationPath, { recursive: true });
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      const filename = path.basename(new URL(url).pathname) || 'downloaded_file';
      const filePath = path.join(fullDestinationPath, filename);

      const fileStream = fs.createWriteStream(filePath);
      if (response.body) {
        // Convert Web ReadableStream to Node.js Readable stream
        // Convert Web ReadableStream to Node.js Readable stream
        // For Node.js 18+, response.body is a ReadableStream (Web Streams API)
        // For pipeline, it needs to be a Node.js Readable stream.
        // A common way to bridge this is to convert the Web ReadableStream to an AsyncIterable
        // and then use Readable.from. However, directly piping is often possible.
        // If response.body is indeed a Web ReadableStream, it can often be directly piped.
        // If not, it needs to be converted.
        // Assuming response.body is a WHATWG ReadableStream, which is generally compatible with Node.js streams.
        await pipeline(Readable.fromWeb(response.body as any), fileStream); // Use Readable.fromWeb for conversion
      } else {
        throw new Error('Response body is null.');
      }

      return filePath; // Return the path to the downloaded file
    } catch (error: any) {
      console.error('Error downloading file:', error);
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }
 
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web-curl MCP server running on stdio');
  }
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  // CLI mode (ESM compatible)
  import('yargs').then(({ default: yargs }) => {
    yargs(process.argv.slice(2))
      .scriptName('web-curl')
      .usage('$0 <url> [options]')
      .option('timeout', { type: 'number', describe: 'Navigation timeout (ms)', default: 60000 })
      .option('blockResources', { type: 'boolean', describe: 'Block images/styles/fonts', default: false })
      .option('maxLength', { type: 'number', describe: 'Max chars to extract', default: 2000 })
      .option('startIndex', { type: 'number', describe: 'Start char index', default: 0 })
      .help()
      .parseAsync()
      .then(async (argv: any) => {
        // Jika tidak ada url, jalankan MCP server
        if (!argv._[0]) {
          const server = new WebCurlServer();
          server.run().catch(console.error);
          return;
        }
        const url = argv._[0];
        const blockResources = argv.blockResources;
        const timeout = argv.timeout;
        const maxLength = argv.maxLength;
        const startIndex = argv.startIndex;
        const server = new WebCurlServer();
        try {
          const result = await (server as any).fetchWebpage(url, {
            blockResources,
            timeout,
            maxLength,
            startIndex,
            maxPages: 1
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.error('[CLI ERROR]', e);
          process.exit(1);
        }
      });
  });
} else {
  const server = new WebCurlServer();
  server.run().catch(console.error);
}
