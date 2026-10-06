import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

export interface GoogleResult {
  title: string;
  link: string;
  snippet: string;
}

export interface GoogleSearchOptions {
  num?: number;
  language?: string;
  site?: string;
  dateRestrict?: string;
  start?: number;
  region?: string;
}

class GoogleSearchLimitError extends Error {}

export async function googleSearch(query: string, opts: GoogleSearchOptions = {}): Promise<GoogleResult[]> {
  // SEARCH_PROVIDER=external -> the external search API is tried first (e.g. a
  // self-hosted router); default / google -> Google Custom Search first. If the
  // primary backend fails for ANY reason (quota, invalid key, network), fall
  // through to the other one and only surface an error when both fail.
  const provider = (process.env.SEARCH_PROVIDER || 'google').trim().toLowerCase();
  const externalFirst = provider === 'external';
  const primary = externalFirst ? externalSearch : googleCustomSearch;
  const secondary = externalFirst ? googleCustomSearch : externalSearch;
  try {
    return await primary(query, opts);
  } catch (primaryError) {
    try {
      return await secondary(query, opts);
    } catch {
      throw primaryError;
    }
  }
}

async function externalSearch(query: string, opts: GoogleSearchOptions): Promise<GoogleResult[]> {
  const apiKey = process.env.SEARCH_API_KEY;
  const endpoint = process.env.SEARCH_BASE_URL;
  const model = process.env.SEARCH_MODEL;
  if (!endpoint || !apiKey || !model) {
    throw new Error('SEARCH_BASE_URL, SEARCH_MODEL, and SEARCH_API_KEY must be configured for Google Search fallback');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      query,
      search_type: 'web',
      max_results: opts.num || 10,
    }),
  });
  if (!response.ok) throw new Error(`External search API error: ${response.status} ${response.statusText}`);

  const data = await response.json() as any;
  if (!Array.isArray(data.results)) throw new Error('External search API returned an invalid response');
  return data.results.map((item: any) => ({
    title: item.title,
    link: item.url || item.link,
    snippet: item.snippet || item.description || '',
  })).filter((item: GoogleResult) => item.title && item.link);
}

async function googleCustomSearch(query: string, opts: GoogleSearchOptions): Promise<GoogleResult[]> {
  const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
  const cx = process.env.CX_GOOGLE_SEARCH;
  if (!apiKey || !cx) throw new Error('APIKEY_GOOGLE_SEARCH and CX_GOOGLE_SEARCH must be configured');

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  if (opts.num) url.searchParams.set('num', String(opts.num));
  if (opts.start) url.searchParams.set('start', String(opts.start));
  if (opts.language) url.searchParams.set('lr', `lang_${opts.language}`);
  if (opts.region) url.searchParams.set('cr', opts.region);
  if (opts.site) url.searchParams.set('siteSearch', opts.site);
  if (opts.dateRestrict) url.searchParams.set('dateRestrict', opts.dateRestrict);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as any;
    const reasons = data.error?.errors?.map((item: any) => item.reason) || [];
    const message = data.error?.message || '';
    if (response.status === 429 || (response.status === 403 && (/quota|rate.?limit|dailylimitexceeded/i.test(message) || reasons.some((reason: string) => /quota|rate.?limit|dailylimitexceeded/i.test(reason))))) {
      throw new GoogleSearchLimitError(`Google Search limit reached: ${response.status}`);
    }
    throw new Error(`Google Search error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  return (data.items || []).map((item: any) => ({ title: item.title, link: item.link, snippet: item.snippet }));
}
