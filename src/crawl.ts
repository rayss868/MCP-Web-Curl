import { fetchHtml } from './fetch-html.js';

export interface CrawlArgs {
  startUrl: string;
  strategy?: 'bfs' | 'dfs' | 'sitemap' | 'map';
  maxPages?: number;
  include?: string[]; // regex patterns; if provided, only URLs matching at least one are kept
  exclude?: string[]; // regex patterns; URLs matching any are dropped
  sameDomain?: boolean;
  delayMs?: number; // politeness delay between requests
  timeoutMs?: number;
  maxDepth?: number;
}

export interface CrawlPage {
  url: string;
  title: string;
  depth: number;
  status: 'ok' | 'error';
  error?: string;
  linksFound: number;
  contentLength: number;
}

export interface CrawlResult {
  startUrl: string;
  strategy: string;
  visited: number;
  errors: number;
  elapsedMs: number;
  pages: CrawlPage[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Crawl a site with BFS or DFS, read URLs from a sitemap, or just list links
 * found on the start page ("map"). include/exclude are regex patterns applied
 * against full URLs; sameDomain restricts to the start host.
 */
export async function runCrawl(args: CrawlArgs): Promise<CrawlResult> {
  const {
    startUrl,
    strategy = 'bfs',
    maxPages = 20,
    include = [],
    exclude = [],
    sameDomain = true,
    delayMs = 250,
    timeoutMs = 30000,
    maxDepth = 3,
  } = args;

  const started = Date.now();

  let startHost: string;
  try {
    startHost = new URL(startUrl).hostname;
  } catch (e) {
    throw new Error(`Invalid startUrl: ${startUrl}`);
  }

  const includeRe = include.map((p) => new RegExp(p));
  const excludeRe = exclude.map((p) => new RegExp(p));

  const passes = (u: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (sameDomain) {
      if (parsed.hostname !== startHost && !parsed.hostname.endsWith('.' + startHost)) return false;
    }
    if (includeRe.length > 0 && !includeRe.some((r) => r.test(u))) return false;
    if (excludeRe.some((r) => r.test(u))) return false;
    return true;
  };

  // Strategy: map → single page, return its link list
  if (strategy === 'map') {
    const page = await visit(startUrl, 0, timeoutMs);
    return {
      startUrl,
      strategy,
      visited: page?.status === 'ok' ? 1 : 0,
      errors: page?.status === 'error' ? 1 : 0,
      elapsedMs: Date.now() - started,
      pages: page ? [page] : [],
    };
  }

  // Strategy: sitemap → parse <loc> entries (supports sitemap index files)
  if (strategy === 'sitemap') {
    const urls = await fetchSitemapUrls(startUrl, timeoutMs);
    const kept = urls.filter(passes).slice(0, maxPages);
    return {
      startUrl,
      strategy,
      visited: kept.length,
      errors: 0,
      elapsedMs: Date.now() - started,
      pages: kept.map((u) => ({
        url: u,
        title: '',
        depth: 0,
        status: 'ok' as const,
        linksFound: 0,
        contentLength: 0,
      })),
    };
  }

  // Strategy: bfs / dfs over pages
  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];

  while (queue.length > 0 && pages.length < maxPages) {
    const item = strategy === 'dfs' ? queue.pop()! : queue.shift()!;
    if (visited.has(item.url)) continue;
    if (!passes(item.url) && item.depth > 0) continue;
    visited.add(item.url);

    const page = await visit(item.url, item.depth, timeoutMs);
    if (page.status === 'ok') {
      pages.push(page);
      if (page.depth < maxDepth) {
        for (const link of page.links) {
          if (!visited.has(link) && passes(link)) {
            queue.push({ url: link, depth: page.depth + 1 });
          }
        }
      }
    } else {
      pages.push(page);
    }

    if (delayMs > 0 && queue.length > 0) await sleep(delayMs);
  }

  const errors = pages.filter((p) => p.status === 'error').length;
  return {
    startUrl,
    strategy,
    visited: pages.length,
    errors,
    elapsedMs: Date.now() - started,
    pages,
  };
}

async function visit(url: string, depth: number, timeoutMs: number): Promise<CrawlPage & { links: string[] }> {
  try {
    const { url: finalUrl, dom } = await fetchHtml(url, { timeoutMs, maxBytes: 4_000_000 });
    const doc = dom.window.document;
    const links = Array.from(doc.querySelectorAll('a[href]'))
      .map((a) => {
        try {
          return new URL(a.getAttribute('href') || '', finalUrl).href;
        } catch (e) {
          return null;
        }
      })
      .filter((u): u is string => !!u);

    return {
      url: finalUrl,
      title: doc.title.trim() || '',
      depth,
      status: 'ok',
      linksFound: links.length,
      contentLength: doc.documentElement?.outerHTML.length || 0,
      links,
    };
  } catch (e: any) {
    return { url, title: '', depth, status: 'error', error: e.message, linksFound: 0, contentLength: 0, links: [] };
  }
}

async function fetchSitemapUrls(startUrl: string, timeoutMs: number): Promise<string[]> {
  const candidates = [
    startUrl,
    new URL('/sitemap.xml', startUrl).href,
    new URL('/sitemap_index.xml', startUrl).href,
    new URL('/sitemap-index.xml', startUrl).href,
  ];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!/<loc>/i.test(text)) continue;

      const locs = Array.from(text.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)).map((m) => m[1].trim());
      if (locs.length > 0) {
        // Detect sitemap index: entries pointing at other sitemaps
        const nested = locs.filter((l) => /\.xml($|\?)/i.test(l));
        if (nested.length > 0) {
          const childUrls: string[] = [];
          for (const n of nested) {
            const child = await fetchSitemapUrls(n, timeoutMs);
            childUrls.push(...child);
          }
          return childUrls.length > 0 ? childUrls : locs;
        }
        return locs;
      }
    } catch (e) {
      // try next candidate
    }
  }
  throw new Error(`No sitemap found at ${startUrl} (tried /sitemap.xml and variants)`);
}