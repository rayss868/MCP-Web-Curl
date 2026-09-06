import { JSDOM } from 'jsdom';

export interface FetchedPage {
  url: string; // Final URL after redirects
  html: string;
  contentType: string;
  status: number;
  dom: JSDOM;
}

export interface FetchHtmlOptions {
  timeoutMs?: number;
  maxBytes?: number;
  requireHtml?: boolean;
}

/**
 * Fetch a URL and parse it into a JSDOM document. Enforces a timeout and a
 * response-size cap so research/crawl/extract never hang or blow up memory.
 */
export async function fetchHtml(url: string, opts: FetchHtmlOptions = {}): Promise<FetchedPage> {
  const { timeoutMs = 30000, maxBytes = 8_000_000, requireHtml = true } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (requireHtml && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
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