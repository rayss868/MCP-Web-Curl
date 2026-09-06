import { googleSearch } from './search.js';
import { runExtract } from './extract.js';

export interface AgentField {
  name: string;
  selector?: string; // CSS selector for the field
  attr?: string; // optional attribute to read
  jsonLdPath?: string; // e.g. "0.offers.price" — path into the first JSON-LD block
  type?: 'text' | 'number' | 'boolean' | 'url';
  required?: boolean;
}

export interface AgentArgs {
  urls?: string[];
  query?: string; // used to discover urls via search when urls is empty
  maxUrls?: number;
  fields: AgentField[];
}

export interface AgentRecord {
  [key: string]: any;
}

export interface AgentResult {
  records: AgentRecord[];
  errors: { url: string; error: string }[];
}

/**
 * Collect structured data across pages: either from explicit URLs or from the
 * top results of a search query. Each page is read against the given field
 * schema (CSS selectors and/or JSON-LD paths) and flattened into a record.
 */
export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  const { urls = [], query, maxUrls = 5, fields } = args;

  if (!fields || fields.length === 0) throw new Error('fields is required');

  let targets = urls.filter((u) => typeof u === 'string' && u.length > 0);
  if (targets.length === 0) {
    if (!query || !query.trim()) throw new Error('Either urls or query is required');
    const results = await googleSearch(query, { num: maxUrls });
    targets = results.map((r) => r.link).slice(0, maxUrls);
  }

  const records: AgentRecord[] = [];
  const errors: { url: string; error: string }[] = [];

  for (const url of targets) {
    try {
      const ex = await runExtract({
        url,
        selectors: fields
          .filter((f) => f.selector)
          .map((f) => ({ name: f.name, css: f.selector!, attr: f.attr })),
        includeTables: false,
        includeJsonLd: fields.some((f) => f.jsonLdPath),
        includeMeta: true,
        includeMainContent: false,
      });

      const record: AgentRecord = { _url: ex.finalUrl || url, _title: ex.title };
      for (const f of fields) {
        let value: any = null;
        if (f.jsonLdPath) {
          value = readJsonLdPath(ex.jsonLd, f.jsonLdPath);
        } else if (f.selector) {
          value = ex.custom[f.name] ?? null;
        }
        record[f.name] = coerce(value, f.type);
        if (f.required && (record[f.name] === null || record[f.name] === undefined || record[f.name] === '')) {
          throw new Error(`required field "${f.name}" not found on ${url}`);
        }
      }
      records.push(record);
    } catch (e: any) {
      errors.push({ url, error: e.message });
    }
  }

  return { records, errors };
}

/** Navigate a path like "0.offers.price" or "0.author.0.name" inside a JSON-LD graph. */
function readJsonLdPath(jsonLd: any[], path: string): any {
  const parts = path.split('.');
  let current: any = jsonLd;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      const idx = /^\d+$/.test(part) ? parseInt(part, 10) : 0;
      current = current[idx];
    } else {
      current = current[part];
    }
  }
  return current === undefined ? null : current;
}

function coerce(value: any, type?: string): any {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const n = parseFloat(String(value).replace(/[^\d.-]/g, ''));
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
    case 'url': {
      try {
        return new URL(String(value)).href;
      } catch (e) {
        return null;
      }
    }
    default:
      return String(value).trim();
  }
}