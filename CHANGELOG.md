# Changelog

## [1.0.1] - 2025-08-13

### Major Enhancements

- **Modularized all tool handlers** in `src/index.ts` for maintainability and extensibility.
- **Advanced smart_command**: 
  - Automatic language detection (using `franc-min`).
  - Auto-translate to English (using `translate`) if needed.
  - Query enrichment for better Google Search results.
- **fetch_webpage**:
  - Supports main article extraction using Readability and jsdom.
  - Supports multi-page crawling with `nextPageSelector` and `maxPages` options.
  - Returns structured output: text, html, mainContent, metadata.
- **google_search**:
  - Added advanced parameters: `language`, `region`, `site`, `dateRestrict`.
  - Flexible query building for more powerful search.
- **All tools**:
  - Added `debug` mode for verbose output/logging.
  - Improved error and success logging to `logs/error-log.txt`.
  - All tool descriptions and input/output schema documentation are now in English.
  - Input schemas are more flexible and descriptive.

### Documentation

- Updated tool descriptions and input/output schema documentation in code (ListToolsRequestSchema) to be clear and in English.
- Added this `CHANGELOG.md` to track major updates and improvements.

### Dependencies

- Added: `franc-min`, `translate`, `@mozilla/readability`, `jsdom`, `@types/jsdom`.
