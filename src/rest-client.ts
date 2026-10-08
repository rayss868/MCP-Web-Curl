
import 'dotenv/config';

/** Content format requested from the external fetch API fallback. */
export type FallbackFormat = 'html' | 'markdown' | 'text';

const FALLBACK_FORMATS: FallbackFormat[] = ['html', 'markdown', 'text'];

const FALLBACK_CONTENT_TYPE: Record<FallbackFormat, string> = {
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
};

/** Validate a caller-supplied format, falling back to the default. Throws on unknown values. */
export const normalizeFallbackFormat = (value: unknown, defaultValue: FallbackFormat): FallbackFormat => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'string' && (FALLBACK_FORMATS as string[]).includes(value)) {
    return value as FallbackFormat;
  }
  throw new Error(`Invalid format: ${JSON.stringify(value)}. Valid values: ${FALLBACK_FORMATS.join(', ')}`);
};

/**
 * Errors worth retrying: timeouts/aborts, connection blips, and transient
 * HTTP statuses (5xx, 408, 429). Other 4xx are final.
 */
export const isTransientError = (e: any): boolean => {
  const msg = String(e?.message || e || '');
  if (e?.name === 'AbortError') return true;
  if (/\bHTTP (5\d\d|408|429)\b/.test(msg)) return true;
  if (/\bstatus (5\d\d|408|429)\b/.test(msg)) return true;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(msg)) {
    return true;
  }
  return false;
};

/**
 * Run `fn` up to `attempts` times, backing off between tries (base delay,
 * then 3x). Stops immediately on non-transient errors.
 */
export const withRetries = async <T>(fn: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T> => {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i === attempts - 1 || !isTransientError(e)) throw e;
      await new Promise((r) => setTimeout(r, i === 0 ? baseDelayMs : baseDelayMs * 3));
    }
  }
  throw lastErr;
};

// Define the interface for the fetch_api tool arguments
export interface FetchApiArgs {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: any; // Can be string, Buffer, stream, or URLSearchParams
  timeout?: number; // Timeout in milliseconds
  limit: number; // Maximum number of characters to return in the response body (required)
  redirect?: 'follow' | 'error' | 'manual'; // Redirect mode
  format?: FallbackFormat; // Content format for the external API fallback (GET only)
}

// Validate the arguments for fetch_api tool
export const isValidFetchApiArgs = (args: any): args is FetchApiArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (typeof args.url !== 'string') return false;
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(args.method)) return false;
  if (args.headers !== undefined && (typeof args.headers !== 'object' || args.headers === null || Array.isArray(args.headers))) return false;
  // body can be of various types, so a simple check might not be sufficient,
  // but for now, we'll assume it's provided correctly if it exists.
  if (args.timeout !== undefined && typeof args.timeout !== 'number') return false;
  if (args.limit === undefined || typeof args.limit !== 'number') return false; // limit is required and must be a number
  if (args.redirect !== undefined && !['follow', 'error', 'manual'].includes(args.redirect)) return false;
  if (args.format !== undefined && !FALLBACK_FORMATS.includes(args.format)) return false;
  return true;
};

export interface FetchApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
  url: string;
  bodyLength?: number; // length of the un-truncated body (characters)
  truncated?: boolean; // whether the body was truncated to satisfy limit
  responseTimeMs: number; // Add response time in milliseconds
}

export const fetchWebFallback = async (
  url: string,
  timeout: number,
  format: FallbackFormat = 'markdown'
): Promise<Response> => {
  const endpoint = process.env.EXTERNAL_API_URL;
  const apiKey = process.env.EXTERNAL_API_KEY;
  const model = process.env.EXTERNAL_API_MODEL;
  if (!endpoint || !apiKey || !model) {
    throw new Error('EXTERNAL_API_URL, EXTERNAL_API_KEY, and EXTERNAL_API_MODEL are required for web fetch fallback');
  }

  let attempts = 0;
  try {
    return await withRetries(async () => {
      attempts++;
      // Fresh controller per attempt so a previous timeout never poisons the next try.
      const attemptController = new AbortController();
      const timeoutId = setTimeout(() => attemptController.abort(), timeout);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, url, format, max_characters: 0 }),
          signal: attemptController.signal,
        });
        if (!response.ok) throw new Error(`External web fetch failed with status ${response.status}`);

        const result = await response.json();
        const content = result.content;
        // Shape 1: content is a plain string. Shape 2: content is an object
        // { format, text } (jina-reader style). Both are accepted.
        const text =
          typeof content === 'string'
            ? content
            : content && typeof content.text === 'string'
              ? content.text
              : undefined;
        if (text === undefined) throw new Error('External web fetch response has no content');
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': FALLBACK_CONTENT_TYPE[format] },
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }, 3, 1000);
  } catch (e: any) {
    if (attempts > 1) {
      throw new Error(`External web fetch failed after ${attempts} attempts (${e?.message || e})`);
    }
    throw e;
  }
};

// Function to make the API request
export const fetchApi = async (args: FetchApiArgs): Promise<FetchApiResponse> => {
  const { url, method, headers, body, timeout = 60000, limit, redirect = 'follow' } = args;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const startTime = performance.now(); // Start time measurement

  try {
    const options: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      redirect, // Add redirect option
      // The `timeout` option is specific to `node-fetch` and not part of the standard `RequestInit`.
      // The timeout logic is now handled manually using AbortController.
    };

    if (body !== undefined) {
      if (typeof body === 'object' && headers && headers['Content-Type'] === 'application/json') {
        options.body = JSON.stringify(body);
      } else {
        options.body = body; // Works for string, Buffer, FormData, URLSearchParams
      }
    }

    let response: Response;
    if (method === 'GET') {
      let directResponse: Response | undefined;
      try {
        // One retry for transient failures; final statuses (403, 404, ...)
        // throw straight through to the API fallback below.
        directResponse = await withRetries(async () => {
          const r = await fetch(url, options);
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
          return r;
        }, 2, 1000);
      } catch {
        directResponse = undefined;
      }
      clearTimeout(timeoutId);
      response = directResponse?.ok ? directResponse : await fetchWebFallback(url, timeout, args.format);
    } else {
      response = await fetch(url, options);
      clearTimeout(timeoutId);
    }

    const endTime = performance.now(); // End time measurement
    const responseTimeMs = endTime - startTime; // Calculate response time

    let responseBody: any;
    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('application/json')) {
      responseBody = await response.json();
    } else if (contentType && (contentType.includes('text/') || contentType.includes('application/xml') || contentType.includes('application/xhtml+xml'))) {
      responseBody = await response.text();
    } else {
      // For binary data or unknown content types, try to get as buffer then base64 encode
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

    // Enforce output limit: convert body to string for length measurement/truncation.
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
      // When truncation is necessary, return a string truncated to 'limit' characters.
      finalBody = fullBodyString.substring(0, limit);
      truncated = true;
    } else {
      // If not truncated and original was JSON-parsed, keep original parsed object,
      // otherwise keep the string.
      finalBody = responseBody;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: finalBody,
      ok: response.ok,
      url: response.url,
      bodyLength,
      truncated,
      responseTimeMs, // Include response time
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000} seconds`);
    }
    throw error;
  }
};
