export interface GoogleResult {
  title: string;
  link: string;
  snippet: string;
}

export interface GoogleSearchOptions {
  num?: number;
  language?: string; // e.g. 'id', 'en' (maps to lr=lang_xx)
  site?: string;
  dateRestrict?: string; // e.g. 'd1', 'm6', 'y1'
  start?: number;
}

/**
 * Single Google Custom Search query. Uses the same env keys as the existing
 * multi_search/google_search tools.
 */
export async function googleSearch(query: string, opts: GoogleSearchOptions = {}): Promise<GoogleResult[]> {
  const apiKey = process.env.APIKEY_GOOGLE_SEARCH;
  const cx = process.env.CX_GOOGLE_SEARCH;
  if (!apiKey || !cx) throw new Error('Google Search API keys not configured');

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  if (opts.num) url.searchParams.set('num', String(opts.num));
  if (opts.start) url.searchParams.set('start', String(opts.start));
  if (opts.language) url.searchParams.set('lr', `lang_${opts.language}`);
  if (opts.site) url.searchParams.set('siteSearch', opts.site);
  if (opts.dateRestrict) url.searchParams.set('dateRestrict', opts.dateRestrict);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Google Search error: ${response.status} ${response.statusText}`);
  const data = await response.json() as any;
  return (data.items || []).map((item: any) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet
  }));
}