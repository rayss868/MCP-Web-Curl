import { googleSearch, GoogleResult } from './search.js';
import { fetchHtml, FetchedPage } from './fetch-html.js';
import { Readability } from '@mozilla/readability';

export interface ResearchArgs {
  query: string;
  maxSubQueries?: number;
  maxResultsPerQuery?: number;
  language?: string;
  site?: string;
  dateRestrict?: string;
  /** How many top sources to fetch and include real content for. Clamped to 5-10 (default 5, 10 recommended). */
  fetchSources?: number;
}

export interface ResearchSource {
  citation: number; // matches the [n] numbering in the report
  title: string;
  url: string;
  status: 'ok' | 'failed';
  via: 'direct' | 'fallback' | 'raw' | 'none';
  content: string; // real page excerpt (markdown/text), when status=ok
  error?: string;
}

export interface ResearchResult {
  query: string;
  subQueries: string[];
  results: { subQuery: string; items: GoogleResult[] }[];
  citations: string[]; // numbered source list: "1. Title — link"
  sources: ResearchSource[]; // fetched top sources with their real content
  report: string; // markdown report with inline [n] citations + source content
}

const FETCH_SOURCES_DEFAULT = 5;
const FETCH_SOURCES_MIN = 5;
const FETCH_SOURCES_MAX = 10;
const SOURCE_EXCERPT_CHARS = 1500;
const SOURCE_FETCH_TIMEOUT_MS = 20000;

/**
 * Research pipeline: decompose a question into language-aware sub-queries,
 * run them in parallel, dedupe results, fetch the top unique sources
 * (direct fetch with external API fallback), and emit a markdown report
 * where every claim is backed by a numbered citation and the top sources
 * contribute their real page content — not just links.
 */
export async function runResearch(args: ResearchArgs): Promise<ResearchResult> {
  const {
    query,
    maxSubQueries = 4,
    maxResultsPerQuery = 5,
    language,
    site,
    dateRestrict,
  } = args;

  if (!query || !query.trim()) throw new Error('query is required');

  const fetchSources = clampFetchSources(args.fetchSources);
  const subQueries = decompose(query, language).slice(0, maxSubQueries);

  const groups = (
    await Promise.all(
      subQueries.map(async (subQuery) => ({
        subQuery,
        items: await googleSearch(subQuery, { num: maxResultsPerQuery, language, site, dateRestrict }),
      }))
    )
  ).map((g) => ({ subQuery: g.subQuery, items: dedupeItems(g.items) }));

  // Citation order = first appearance across sub-queries (deduped by URL).
  const ordered: GoogleResult[] = [];
  const seenUrls = new Set<string>();
  groups.forEach((g) =>
    g.items.forEach((it) => {
      const key = normalizeUrl(it.link);
      if (seenUrls.has(key)) return;
      seenUrls.add(key);
      ordered.push(it);
    })
  );

  const sources = await fetchTopSources(ordered.slice(0, fetchSources));
  // Every unique result gets its citation number by position, so body, the
  // fetched-source section, and the Citations list always agree.
  const numbering = new Map(ordered.map((it, i) => [normalizeUrl(it.link), i + 1]));

  const citations = ordered.map((it, i) => `${i + 1}. ${it.title}\n   ${it.link}`);
  const report = buildReport(query, groups, citations, sources, numbering);

  return { query, subQueries, results: groups, citations, sources, report };
}

function clampFetchSources(value: number | undefined): number {
  const n = Math.round(Number(value ?? FETCH_SOURCES_DEFAULT));
  if (!Number.isFinite(n)) return FETCH_SOURCES_DEFAULT;
  return Math.min(FETCH_SOURCES_MAX, Math.max(FETCH_SOURCES_MIN, n));
}

const ID_RE =
  /\b(yang|dan|atau|untuk|dengan|adalah|apa|bagaimana|kenapa|mengapa|perbandingan|kelebihan|kekurangan|cara|biaya|harga|terbaru|fungsi|kegunaan|panduan|tutorial|terbaik|gratis|berbayar|antara|dalam|menggunakan|membandingkan|beserta|secara|implementasi)\b/i;

/**
 * Language-aware decomposition: keep the raw query, split it on common
 * connectors, then add framing variants in the query's language (Indonesian
 * or English) so sub-queries are not near-duplicates with English-only filler.
 */
function decompose(query: string, language?: string): string[] {
  const year = new Date().getFullYear();
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return [];

  const isId = language === 'id' || (language !== 'en' && ID_RE.test(q));

  const out: string[] = [q];
  const add = (s: string) => {
    const v = s.trim().replace(/\s+/g, ' ');
    if (!v || v.length < 4) return;
    const norm = normalizeTitle(v);
    if (out.some((existing) => normalizeTitle(existing) === norm)) return;
    out.push(v);
  };

  // Split on connectors; keep only fragments that stand on their own
  // (multi-word or reasonably long) — single weak words add noise.
  q.split(/\s+(?:vs\.?|versus|and|dan|atau|or)\s+|\s*[;,]\s*/i)
    .map((s) => s.trim())
    .filter((s) => {
      const words = s.split(/\s+/).length;
      return words >= 2 || s.length >= 8;
    })
    .forEach(add);

  // Framing variants in the query language (never duplicate the raw query,
  // and never bolt "what is/apa itu" onto an existing question).
  const isQuestion = /^(how|what|why|when|who|where|which|is|are|do|does|did|can|could|should|would|apa|bagaimana|kenapa|mengapa|siapa|kapan|dimana|mana|bisakah|apakah)\b/i.test(q);
  if (out.length < 3 && !isQuestion) add(isId ? `apa itu ${q}` : `what is ${q}`);
  if (out.length < 4 && !/\b\d{4}\b/.test(q)) add(isId ? `${q} terbaru ${year}` : `${q} ${year}`);
  if (out.length < 5) add(isId ? `kelebihan kekurangan ${q}` : `benefits of ${q}`);

  return out;
}

/** Fetch the top unique sources and capture their real content. */
async function fetchTopSources(items: GoogleResult[]): Promise<ResearchSource[]> {
  return Promise.all(
    items.map(async (it, i) => {
      const base: ResearchSource = {
        citation: i + 1,
        title: it.title,
        url: it.link,
        status: 'failed',
        via: 'none',
        content: '',
      };
      try {
        const page: FetchedPage = await fetchHtml(it.link, {
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
          maxBytes: 2_000_000,
          requireHtml: false,
        });
        const content = pageText(page).slice(0, SOURCE_EXCERPT_CHARS);
        return {
          ...base,
          status: content ? 'ok' : 'failed',
          via: classifyFetch(page),
          content,
          error: content ? undefined : 'page produced no readable text',
        };
      } catch (e: any) {
        return { ...base, error: String(e?.message || e) };
      }
    })
  );
}

function classifyFetch(page: FetchedPage): 'direct' | 'fallback' | 'raw' {
  const ct = page.contentType;
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return 'direct';
  if (ct.includes('markdown')) return 'fallback'; // external API fallback returns text/markdown
  return 'raw';
}

/** Best-effort readable text from a fetched page. */
function pageText(page: FetchedPage): string {
  if (!page.contentType.includes('html')) return normalizeWhitespace(page.html);
  try {
    const article = new Readability(page.dom.window.document).parse();
    if (article?.textContent) return normalizeWhitespace(article.textContent);
  } catch {
    // Readability can throw on unusual documents; fall back to body text.
  }
  const body = page.dom.window.document.body?.textContent || '';
  return normalizeWhitespace(body);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip HTML tags and common entities from search snippets. */
function stripHtml(s: string): string {
  return normalizeWhitespace(
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
  );
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return (parsed.hostname.replace(/^www\./, '') + parsed.pathname).replace(/\/+$/, '');
  } catch {
    return u.replace(/\/+$/, '').toLowerCase();
  }
}

/** Drop duplicate results within a group (by URL, then by normalized title). */
function dedupeItems(items: GoogleResult[]): GoogleResult[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: GoogleResult[] = [];
  for (const it of items) {
    const u = normalizeUrl(it.link);
    const t = normalizeTitle(it.title || '');
    if (seenUrl.has(u) || (t && seenTitle.has(t))) continue;
    seenUrl.add(u);
    if (t) seenTitle.add(t);
    out.push(it);
  }
  return out;
}

function buildReport(
  query: string,
  groups: { subQuery: string; items: GoogleResult[] }[],
  citations: string[],
  sources: ResearchSource[],
  numbering: Map<string, number>
): string {
  const lines: string[] = [];
  lines.push(`# Research: ${query}`);
  lines.push('');
  lines.push(
    `_Sub-queries: ${groups.length} · Sumber di-fetch: ${sources.filter((s) => s.status === 'ok').length}/${sources.length}_`
  );
  lines.push('');

  const seen = new Set<string>();
  groups.forEach((g) => {
    lines.push(`## ${g.subQuery}`);
    lines.push('');
    if (g.items.length === 0) {
      lines.push('_No results found._');
      lines.push('');
      return;
    }
    g.items.forEach((it) => {
      const key = normalizeUrl(it.link);
      if (seen.has(key)) return;
      seen.add(key);
      const n = numbering.get(key);
      const tag = n ? `[${n}]` : `[-]`;
      lines.push(`${tag} **${stripHtml(it.title)}**`);
      lines.push(`\`${it.link}\``);
      const snippet = stripHtml(it.snippet || '');
      if (snippet) lines.push(`> ${snippet}`);
      lines.push('');
    });
  });

  // Real content from fetched sources — the core of a useful research dump.
  const ok = sources.filter((s) => s.status === 'ok');
  if (ok.length > 0) {
    lines.push('---');
    lines.push('## Konten Sumber (di-fetch langsung)');
    lines.push('');
    ok.forEach((s) => {
      lines.push(`### [${s.citation}] ${stripHtml(s.title)}`);
      lines.push(`\`${s.url}\`${s.via === 'fallback' ? ' _(via API fallback)_' : ''}`);
      lines.push('');
      lines.push(s.content);
      lines.push('');
    });
  }

  const failed = sources.filter((s) => s.status === 'failed');
  if (failed.length > 0) {
    lines.push('---');
    lines.push(`## Sumber gagal di-fetch (${failed.length})`);
    failed.forEach((s) => lines.push(`- [${s.citation}] ${s.url} — ${s.error || 'unknown error'}`));
    lines.push('');
  }

  lines.push('---');
  lines.push(`## Citations (${citations.length})`);
  citations.forEach((c) => lines.push(c));

  return lines.join('\n');
}
