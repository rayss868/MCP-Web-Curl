import { JSDOM } from 'jsdom';
import { fetchWebFallback } from './rest-client.js';

export interface FetchedPage {
  url: string; // Final URL after redirects
  html: string; // Raw response body as text (HTML markup or plain text)
  contentType: string;
  status: number;
  dom: JSDOM;
}

export interface FetchHtmlOptions {
  timeoutMs?: number;
  maxBytes?: number;
  requireHtml?: boolean;
  /** Format requested from the external API fallback (default markdown). */
  fallbackFormat?: 'html' | 'markdown' | 'text';
}

/**
 * Fetch a URL and parse it into a JSDOM document. Enforces a timeout and a
 * response-size cap so research/crawl/extract never hang or blow up memory.
 *
 * If the direct fetch fails for any reason (blocked 403/429, 5xx, network
 * error, timeout), it falls back to the external fetch API (EXTERNAL_API_*)
 * and returns that content as markdown.
 */
export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<FetchedPage> {
  const { timeoutMs = 30000, maxBytes = 8_000_000, requireHtml = true } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  let fromFallback = false;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  } catch (directError: any) {
    // Direct fetch failed (blocked, HTTP error, network error, timeout) →
    // fall back to the external fetch API, same policy as fetch_api.
    clearTimeout(timer);
    try {
      res = await fetchWebFallback(url, timeoutMs, opts.fallbackFormat);
      fromFallback = true;
    } catch (fallbackError: any) {
      throw new Error(
        `Fetch failed (${directError?.message || directError}); API fallback failed (${fallbackError?.message || fallbackError})`
      );
    }
  }

  try {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!fromFallback && requireHtml && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error(`Not an HTML page (content-type: ${contentType || 'unknown'})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.length > maxBytes ? buf.subarray(0, maxBytes).toString('utf8') : buf.toString('utf8');
    const dom = new JSDOM(html, { url: res.url || url });

    return { url: res.url || url, html, contentType, status: res.status, dom };
  } catch (e: any) {
    if (e.name === 'AbortError') throw new Error(`Fetch timed out after ${timeoutMs}ms for ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}