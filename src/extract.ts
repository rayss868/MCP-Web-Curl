import { Readability } from '@mozilla/readability';
import { fetchHtml } from './fetch-html.js';

export interface ExtractSelector {
  name: string;
  css: string;
  attr?: string; // optional attribute to read instead of text content
  all?: boolean; // if true, return an array of all matches
}

export interface ExtractArgs {
  url: string;
  selectors?: ExtractSelector[];
  includeTables?: boolean;
  includeJsonLd?: boolean;
  includeMeta?: boolean;
  includeMainContent?: boolean;
  maxTextChars?: number;
}

/**
 * Extract structured content from an HTML page:
 *  - CSS selector based fields
 *  - tables (array of rows, each row an array of cell texts)
 *  - meta tags + JSON-LD blocks
 *  - Readability main-content extraction
 *  - heuristic schema-type detection (og:type / JSON-LD @type)
 */
export async function runExtract(args: ExtractArgs): Promise<any> {
  const {
    url,
    selectors = [],
    includeTables = true,
    includeJsonLd = true,
    includeMeta = true,
    includeMainContent = true,
    maxTextChars = 20000,
  } = args;

  const { url: finalUrl, dom } = await fetchHtml(url);
  const doc = dom.window.document;

  const title = doc.title.trim() || doc.querySelector('h1')?.textContent?.trim() || '';

  const meta: Record<string, string> = {};
  if (includeMeta) {
    doc.querySelectorAll('meta').forEach((m) => {
      const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
      const content = m.getAttribute('content');
      if (name && content) meta[name] = content;
    });
  }

  const jsonLd: any[] = [];
  if (includeJsonLd) {
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        jsonLd.push(JSON.parse(s.textContent || '{}'));
      } catch (e) {
        // ignore malformed JSON-LD blocks
      }
    });
  }

  const schemaTypes = detectSchemaTypes(jsonLd, meta);

  const tables: string[][][] = [];
  if (includeTables) {
    doc.querySelectorAll('table').forEach((tbl) => {
      const rows: string[][] = [];
      tbl.querySelectorAll('tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
          (c.textContent || '').trim().replace(/\s+/g, ' ')
        );
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) tables.push(rows);
    });
  }

  const custom: Record<string, string | string[] | null> = {};
  for (const sel of selectors) {
    const nodes = Array.from(doc.querySelectorAll(sel.css));
    if (sel.all) {
      custom[sel.name] = nodes.map((n) =>
        sel.attr ? n.getAttribute(sel.attr) || '' : (n.textContent || '').trim()
      );
    } else {
      const first = nodes[0];
      if (!first) {
        custom[sel.name] = null;
      } else {
        custom[sel.name] = sel.attr ? first.getAttribute(sel.attr) : (first.textContent || '').trim();
      }
    }
  }

  let mainContent: string | undefined;
  if (includeMainContent) {
    try {
      const article = new Readability(dom.window.document).parse();
      if (article?.textContent) mainContent = article.textContent.trim().slice(0, maxTextChars);
    } catch (e) {
      // Readability can throw on unusual documents; fall back to no main content.
    }
  }

  return {
    url,
    finalUrl,
    title,
    meta,
    schemaTypes,
    jsonLd,
    tables,
    custom,
    mainContent,
  };
}

function detectSchemaTypes(jsonLd: any[], meta: Record<string, string>): string[] {
  const types = new Set<string>();

  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v['@type']) {
      if (Array.isArray(v['@type'])) v['@type'].forEach((t: string) => types.add(t));
      else types.add(String(v['@type']));
    }
    Object.values(v).forEach(walk);
  };
  jsonLd.forEach(walk);

  if (meta['og:type']) types.add(meta['og:type']);
  if (meta['itemprop']) types.add(meta['itemprop']);
  return Array.from(types);
}