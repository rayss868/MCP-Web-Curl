# Changelog

## [1.0.6] - 2025-10-27

### Added

- `fetch_webpage` tool now supports an `evaluateScript` parameter, allowing arbitrary JavaScript code to be executed on the loaded page. The result of the script execution is included in the tool's output as `evaluatedScriptResult`.
- `fetch_api` tool now supports a `redirect` parameter ('follow', 'error', 'manual') to control automatic redirection behavior.
- `fetch_api` tool now supports a `timeout` parameter in milliseconds, allowing users to specify how long to wait for an API response before timing out.
- `fetch_api` tool now includes `responseTimeMs` in its output, indicating the time taken for the API request in milliseconds.

### Added

- `fetch_api` tool now supports a `redirect` parameter ('follow', 'error', 'manual') to control automatic redirection behavior.
- `fetch_api` tool now supports a `timeout` parameter in milliseconds, allowing users to specify how long to wait for an API response before timing out.
- `fetch_api` tool now includes `responseTimeMs` in its output, indicating the time taken for the API request in milliseconds.

## [1.0.5] - 2025-08-20

### Changed

- Replaced `node-fetch` with the native global `fetch` API for reduced dependencies and improved project setup.
- Updated `README.md` with enhanced documentation, including a Mermaid architecture diagram, clarified feature descriptions, and updated installation notes.

## [1.0.4] - 2025-08-19

### Changed

- **`fetch_webpage` tool updates:**
    - Implemented whitespace removal from fetched HTML content.
    - Modified content slicing to operate on the whitespace-removed HTML.
    - Updated response to include `startIndex`, `maxLength`, `remainingCharacters`, and a clear `instruction` for fetching subsequent chunks (now includes a suggestion to stop if enough information is gathered).
    - `blockResources` parameter is now always forced to `false` within the `fetch_webpage` tool, effectively disabling resource blocking. Related automatic retry logic was removed.
    - The CLI default for `blockResources` was also changed to `false`.
    - Removed `chunkOverlap` parameter and related logic.
    - Removed `totalChunks` and `currentChunk` from the `fetch_webpage` tool's final response.

### Fixed

- Resolved TypeScript errors related to `chunkOverlap` references across the codebase.

## [1.0.3] - 2025-08-16

### Added

- Added `download_file` tool to download files to disk (supports relative and absolute `destinationFolder`; the server creates the destination folder if it does not exist).
- Added streaming download implementation using Node streams and pipeline for robust file writes.
- `fetch_api` now requires a `limit` parameter (number). The REST client will truncate response output to at most `limit` characters to avoid oversized outputs.
- `fetch_api` is marked `autoApprove` in the MCP tool listing so it can be invoked without interactive approval by compatible MCP hosts.
- Response metadata for `fetch_api`: returned object includes `bodyLength` (original body length in characters) and `truncated` (boolean indicating whether the body was truncated).

### Fixes & Improvements

- Accept relative paths for `download_file` `destinationFolder`; resolve against `process.cwd()` (previously required absolute path).
- Ensure `logs/` directory is created at startup to prevent logging failures when appending to `logs/error-log.txt`.
- Remove duplicate `download_file` handler in `CallToolRequestSchema`.
- Documentation: clarify `download_file` `destinationFolder` behavior in `README.md`.
- Improve robustness of error logging when writing to disk.
- Updated internal calls to `fetchApi` to provide a sensible default `limit` of 1000 characters.
- Documentation: README and tool schema updated to document the required `limit` parameter and auto-approve behavior.


## [1.0.2] - 2025-08-14

### Minor Enhancements

- **Storage management**:
  - Error log file is automatically rotated if it exceeds 1MB to prevent unlimited growth.
  - Old temporary files in the logs directory are cleaned up at startup.
  - The browser is always closed after each operation to prevent Chromium temp file leaks.

- **Error logging**: All tool errors are logged to `logs/error-log.txt` for troubleshooting.
- **Chunking options**: Added `chunkOverlap` parameter for overlapping content chunks in `fetch_webpage`.
- **Smart command improvements**: Fallback to original query if translation fails, and simple query enrichment logic (adds "best tips" if not present).

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
