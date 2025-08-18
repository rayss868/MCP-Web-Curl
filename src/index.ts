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
import fetch from 'node-fetch'; // Import fetch
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
  chunkSize?: number;
  chunkOverlap?: number;
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
        version: '1.0.3',
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
                description: 'Navigation timeout in milliseconds (default: 60000)'
              },
              maxLength: {
                type: 'number',
                description: 'DEPRECATED. Use chunkSize instead. Maximum number of characters to return (default: 4000).'
              },
              startIndex: {
                type: 'number',
                description: 'Start character index for content extraction (required; default: 0).'
              },
              chunkSize: {
                type: 'number',
                description: 'The size of each content chunk in characters. When provided, the tool enters chunking mode. (Preferred; required unless legacy "limit" or "maxLength" provided).'
              },
              limit: {
                type: 'number',
                description: 'Alias for chunkSize (legacy). Accepts same values as chunkSize.'
              },
              chunkOverlap: {
                type: 'number',
                description: 'Number of characters to overlap between chunks to maintain context. (Default: 200).'
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
            anyOf: [
              { required: ['chunkSize'] },
              { required: ['limit'] },
              { required: ['maxLength'] }
            ],
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
        // - 'limit' -> chunkSize
        // - 'index' -> startIndex
        try {
          if (typeof (args as any).limit === 'number' && typeof (args as any).chunkSize !== 'number') {
            (args as any).chunkSize = (args as any).limit;
          }
          if (typeof (args as any).index === 'number' && typeof (args as any).startIndex !== 'number') {
            (args as any).startIndex = (args as any).index;
          }
        } catch (e) {
          // ignore mapping errors; validation below will catch invalid shapes
        }

        // Enforce required parameters (runtime validation).
        // Requirement based on confirmation: require startIndex (or index) and at least one of chunkSize/limit/maxLength.
        const hasStartIndex = typeof (args as any).startIndex === 'number';
        const hasChunkish = typeof (args as any).chunkSize === 'number' || typeof (args as any).limit === 'number' || typeof (args as any).maxLength === 'number';
        if (!hasStartIndex) {
          throw new McpError(ErrorCode.InvalidParams, "fetch_webpage: required parameter 'startIndex' (or alias 'index') is missing or not a number");
        }
        if (!hasChunkish) {
          throw new McpError(ErrorCode.InvalidParams, "fetch_webpage: required parameter 'chunkSize' (or alias 'limit' / 'maxLength') is missing or not a number");
        }

        const validatedArgs = args as FetchWebpageArgs & { 
            chunkSize?: number; 
            chunkOverlap?: number;
            nextPageSelector?: string;
            maxPages?: number;
        };

        const {
            url,
            blockResources = true,
            resourceTypesToBlock,
            timeout: rawTimeout,
            maxLength: deprecatedMaxLength,
            startIndex = 0,
            chunkSize,
            chunkOverlap = 200,
            headers,
            username,
            password,
            nextPageSelector,
            maxPages = 1
        } = validatedArgs;

        const timeout = Math.min(rawTimeout || 60000, 120000);
        const isChunking = typeof chunkSize === 'number';
        const maxLength = chunkSize ?? deprecatedMaxLength ?? 4000;

        try {
            const result: any = await this.fetchWebpage(url, {
                blockResources,
                resourceTypesToBlock,
                timeout,
                maxLength,
                startIndex,
                headers,
                username,
                password,
                nextPageSelector,
                maxPages,
                chunkOverlap
            });

            // If chunking, provide clear info about the next step
            if (isChunking && typeof result.contentLength === 'number' && result.contentLength > 0) {
                const effectiveOverlap = result.textContent.length > chunkOverlap ? chunkOverlap : 0;
                const nextStartIndex = startIndex + maxLength - effectiveOverlap;
                const isLastChunk = (startIndex + maxLength) >= result.contentLength;

                const chunkInfo = {
                    ...result,
                    nextStartIndex: isLastChunk ? null : nextStartIndex,
                    isLastChunk,
                    instruction: isLastChunk
                        ? 'This is the last chunk. The entire content has been fetched.'
                        : `To fetch the next chunk, call fetch_webpage again with startIndex=${nextStartIndex}.`,
                };

                return {
                    content: [{ type: 'text', text: JSON.stringify(chunkInfo, null, 2) }],
                };
            }

            // Standard, non-chunked response
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };

        } catch (error: any) {
            console.error('Error fetching webpage:', error);
            return {
                content: [{ type: 'text', text: `Error fetching webpage: ${error.message}` }],
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
              limit: 1000,
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
              maxLength: 4000,
              startIndex: 0,
              maxPages: 1,
              chunkOverlap: 0
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

          // 3. Query enrichment: add relevant keywords (basic intent/entity extraction + multimodal + filters)
          let enrichedQuery = queryEn;

          // Intent detection (English only)
          if (/error|bug|fix|troubleshoot|solution/i.test(enrichedQuery)) {
            enrichedQuery += ' solution fix stackoverflow github issue';
          } else if (/tutorial|how to|guide|step by step|example/i.test(enrichedQuery)) {
            enrichedQuery += ' tutorial guide step by step example';
          } else if (/paper|research|state of the art|sota|survey/i.test(enrichedQuery)) {
            enrichedQuery += ' paper arxiv pdf survey';
          } else if (/download|dataset|data set/i.test(enrichedQuery)) {
            enrichedQuery += ' dataset download filetype:csv filetype:xlsx';
          } else if (!/news|latest|best|tips|how to|guide/i.test(enrichedQuery)) {
            enrichedQuery += ' best tips';
          }

          // Multimodal: PDF, image, video
          if (/pdf|document|paper/i.test(enrichedQuery)) {
            enrichedQuery += ' filetype:pdf';
          }
          if (/image|photo|picture|screenshot/i.test(enrichedQuery)) {
            enrichedQuery += ' images';
          }
          if (/video|youtube|mp4|webm/i.test(enrichedQuery)) {
            enrichedQuery += ' videos';
          }

          // Google filters: inurl, intitle, filetype
          if (/inurl:/i.test(enrichedQuery) === false && /url/i.test(enrichedQuery)) {
            enrichedQuery += ' inurl:' + enrichedQuery.match(/\burl\s*[:=]?\s*(\S+)/i)?.[1] || '';
          }
          if (/intitle:/i.test(enrichedQuery) === false && /title/i.test(enrichedQuery)) {
            enrichedQuery += ' intitle:' + enrichedQuery.match(/\btitle\s*[:=]?\s*(\S+)/i)?.[1] || '';
          }
          if (/filetype:/i.test(enrichedQuery) === false && /(\bpdf\b|\bimage\b|\bvideo\b)/i.test(enrichedQuery)) {
            if (/\bpdf\b/i.test(enrichedQuery)) enrichedQuery += ' filetype:pdf';
            if (/\bimage\b/i.test(enrichedQuery)) enrichedQuery += ' filetype:jpg filetype:png';
            if (/\bvideo\b/i.test(enrichedQuery)) enrichedQuery += ' filetype:mp4 filetype:webm';
          }

          // Entity extraction: year
          const yearMatch = enrichedQuery.match(/\b(20\d{2}|19\d{2})\b/);
          if (yearMatch) {
            enrichedQuery += ` after:${yearMatch[0]}`;
          }
          // Entity extraction: popular technology
          if (/python|javascript|node|react|ai|machine learning|deep learning/i.test(enrichedQuery)) {
            enrichedQuery += ' site:github.com site:stackoverflow.com';
          }

          // Local/global detection (region/language)
          if (/indonesia|indonesian|id\b/i.test(enrichedQuery)) {
            enrichedQuery += ' site:id region:ID';
          } else if (/english|en\b|us\b|america|uk\b|britain/i.test(enrichedQuery)) {
            enrichedQuery += ' region:US';
          }

          // Simple query expansion: synonyms for common topics
          if (/ai|artificial intelligence/i.test(enrichedQuery)) {
            enrichedQuery += ' machine learning deep learning neural network';
          }
          if (/bug|error|issue/i.test(enrichedQuery)) {
            enrichedQuery += ' troubleshooting solution workaround';
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
              limit: 1000,
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
      chunkOverlap: number;
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
                  const typesToBlock = options.resourceTypesToBlock ?? ['image', 'stylesheet', 'font'];
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
              await page.goto(currentUrl, { waitUntil: 'networkidle0', timeout: options.timeout });

              const title = await page.title();

              // Efficiently extract and slice content within the browser context
              const pageContent = await page.evaluate((startIndex, maxLength) => {
                  const body = document.body;
                  const textContent = body.textContent?.trim() || '';
                  const slicedText = textContent.substring(startIndex, startIndex + maxLength);
                  return {
                      fullContentLength: textContent.length,
                      slicedText: slicedText,
                  };
              }, options.startIndex, options.maxLength);
              
              const html = await page.content();
              
              // Use Readability on the full HTML for better article extraction
              let mainContent = null;
              try {
                const { JSDOM } = await import('jsdom');
                const dom = new JSDOM(html, { url: currentUrl });
                const reader = new Readability(dom.window.document);
                mainContent = reader.parse();
                // Also slice the readability output
                if (mainContent && mainContent.textContent) {
                    mainContent.textContent = mainContent.textContent.substring(options.startIndex, options.startIndex + options.maxLength);
                }
              } catch(e) {
                mainContent = null; // Ignore Readability errors
              }

              results.push({
                  url: currentUrl,
                  title,
                  textContent: pageContent.slicedText,
                  contentLength: pageContent.fullContentLength,
                  mainContent: mainContent, // Contains sliced main content
                  fetchedAt: new Date().toISOString(),
              });
              
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
        const nodeReadableStream = Readable.from(response.body);
        await pipeline(nodeReadableStream, fileStream);
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
      .option('blockResources', { type: 'boolean', describe: 'Block images/styles/fonts', default: true })
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
            maxPages: 1,
            chunkOverlap: 0
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
