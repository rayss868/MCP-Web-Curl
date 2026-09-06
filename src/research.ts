import { googleSearch, GoogleResult } from './search.js';

export interface ResearchArgs {
  query: string;
  maxSubQueries?: number;
  maxResultsPerQuery?: number;
  language?: string;
  site?: string;
  dateRestrict?: string;
}

export interface ResearchResult {
  query: string;
  subQueries: string[];
  results: { subQuery: string; items: GoogleResult[] }[];
  citations: string[]; // numbered source list: "1. Title — link"
  report: string; // markdown report with inline [n] citations
}

/**
 * Research pipeline: decompose a question into sub-queries, run them in
 * parallel, dedupe results, and emit a synthesized markdown report where
 * every claim is backed by a numbered citation.
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

  const subQueries = decompose(query).slice(0, maxSubQueries);

  const results = await Promise.all(
    subQueries.map(async (subQuery) => ({
      subQuery,
      items: await googleSearch(subQuery, { num: maxResultsPerQuery, language, site, dateRestrict }),
    }))
  );

  const citations = buildCitations(results);
  const report = buildReport(query, results, citations);

  return { query, subQueries, results, citations, report };
}

/**
 * Heuristic decomposition: keep the raw query, split it on common connectors
 * (and/or/vs/dan/atau), and add framing variants when the split is too small.
 */
function decompose(query: string): string[] {
  const year = new Date().getFullYear();
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return [];

  const out: string[] = [q];
  const add = (s: string) => {
    s = s.trim().replace(/\s+/g, ' ');
    if (s && s.length >= 4 && !out.includes(s)) out.push(s);
  };

  q.split(/\s+(?:vs\.?|versus|and|dan|atau|or)\s+|\s*[;,]\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .forEach(add);

  if (out.length < 3) add(`what is ${q}`);
  if (out.length < 4 && !/\b\d{4}\b/.test(q)) add(`${q} ${year}`);
  if (out.length < 5) add(`${q} overview`);

  return out;
}

function buildCitations(groups: { subQuery: string; items: GoogleResult[] }[]): string[] {
  const seen = new Set<string>();
  const citations: string[] = [];
  groups.forEach((g) =>
    g.items.forEach((it) => {
      if (seen.has(it.link)) return;
      seen.add(it.link);
      citations.push(`${citations.length + 1}. ${it.title}\n   ${it.link}`);
    })
  );
  return citations;
}

function buildReport(
  query: string,
  groups: { subQuery: string; items: GoogleResult[] }[],
  citations: string[]
): string {
  const lines: string[] = [];
  lines.push(`# Research: ${query}`);
  lines.push('');

  let n = 0;
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
      if (seen.has(it.link)) return;
      seen.add(it.link);
      n += 1;
      lines.push(`[${n}] **${it.title}**`);
      lines.push(`\`${it.link}\``);
      if (it.snippet) lines.push(`> ${it.snippet.replace(/\s+/g, ' ')}`);
      lines.push('');
    });
  });

  lines.push('---');
  lines.push(`## Citations (${citations.length})`);
  citations.forEach((c) => lines.push(c));

  return lines.join('\n');
}