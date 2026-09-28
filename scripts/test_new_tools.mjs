import 'dotenv/config';
import { runResearch } from '../build/research.js';
import { runExtract } from '../build/extract.js';
import { runCrawl } from '../build/crawl.js';
import { runAgent } from '../build/agent.js';

async function main() {
  console.log('=== 1. research ===');
  try {
    const r = await runResearch({ query: 'manfaat kopi untuk kesehatan dan jenis kopi terbaik', maxSubQueries: 3, maxResultsPerQuery: 3, language: 'id' });
    console.log('subQueries:', JSON.stringify(r.subQueries));
    console.log('citations:', r.citations.length);
    console.log(r.report.slice(0, 600));
  } catch (e) { console.log('ERR:', e.message); }

  console.log('\n=== 2. extract ===');
  try {
    const x = await runExtract({
      url: 'https://example.com',
      selectors: [{ name: 'heading', css: 'h1' }, { name: 'links', css: 'a', attr: 'href', all: true }],
    });
    console.log('title:', x.title, '| schemaTypes:', JSON.stringify(x.schemaTypes));
    console.log('custom:', JSON.stringify(x.custom).slice(0, 200));
    console.log('mainContent present:', !!x.mainContent, '| tables:', x.tables.length);
  } catch (e) { console.log('ERR:', e.message); }

  console.log('\n=== 3. crawl (sitemap) ===');
  try {
    const c = await runCrawl({ startUrl: 'https://www.sitemaps.org', strategy: 'sitemap', maxPages: 5, sameDomain: true });
    console.log('visited:', c.visited, '| errors:', c.errors, '| pages:', c.pages.length);
    c.pages.slice(0, 3).forEach((p) => console.log(' -', p.url));
  } catch (e) { console.log('ERR:', e.message); }

  console.log('\n=== 4. crawl (map) ===');
  try {
    const c = await runCrawl({ startUrl: 'https://example.com', strategy: 'map', sameDomain: true });
    console.log('visited:', c.visited, '| pages:', c.pages.length);
    const p = c.pages[0];
    console.log('url:', p.url, '| title:', p.title, '| linksFound:', p.linksFound);
  } catch (e) { console.log('ERR:', e.message); }

  console.log('\n=== 5. agent ===');
  try {
    const a = await runAgent({
      urls: ['https://example.com'],
      fields: [
        { name: 'heading', selector: 'h1' },
        { name: 'paragraph', selector: 'p' },
        { name: 'url', type: 'url', selector: 'a', attr: 'href' },
      ],
    });
    console.log(JSON.stringify(a, null, 2).slice(0, 500));
  } catch (e) { console.log('ERR:', e.message); }
}

main();