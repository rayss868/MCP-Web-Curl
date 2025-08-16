import fetch, { RequestInit, Response } from 'node-fetch';

// Define the interface for the fetch_api tool arguments
export interface FetchApiArgs {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: any; // Can be string, Buffer, stream, or URLSearchParams
  timeout?: number; // Timeout in milliseconds
  limit: number; // Maximum number of characters to return in the response body (required)
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
}

// Function to make the API request
export const fetchApi = async (args: FetchApiArgs): Promise<FetchApiResponse> => {
  const { url, method, headers, body, timeout = 60000, limit } = args;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const options: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body !== undefined) {
      if (typeof body === 'object' && headers && headers['Content-Type'] === 'application/json') {
        options.body = JSON.stringify(body);
      } else {
        options.body = body; // Works for string, Buffer, FormData, URLSearchParams
      }
    }

    const response: Response = await fetch(url, options);
    clearTimeout(timeoutId);

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
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000} seconds`);
    }
    throw error;
  }
};
