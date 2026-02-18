# Changelog

## [1.4.2] - 2026-02-17

### Changed
- **Always-Persistent Sessions**: Browser sessions are now always persisted by default. Login cookies and session data are continuously reused from `user_data/` without requiring any toggle.
- **Simplified Browser Config**: Removed `persistSession` from `browser_configure`; now it only handles proxy, user-agent, and viewport settings.
- **Idle Timeout**: Increased browser idle auto-close from 1 minute to 15 minutes.
- **browser_snapshot HTML Mode**: Added raw HTML snapshot slicing via `mode: "html"` with `startIndex`/`endIndex`.
- **Tooling UX**: Improved tool descriptions for better agent tool selection and added `browser_flow` umbrella tool to reduce multi-call workflows.

### Removed
- **`browser_cookies` Tool**: Removed explicit cookie management tool to simplify the browsing workflow and avoid split session state handling.

## [1.4.1] - 2026-02-17

### Added
- **Session Persistence**: Added `persistSession` parameter to `browser_configure` (mandatory). Enabling this allows the AI to save login sessions, cookies, and cache in a local `user_data/` directory.
- **Custom Screenshot Destinations**: `take_screenshot` now supports a `destinationFolder` parameter with automatic directory creation and path validation.
- **Dynamic Cleanup**: The 5-day automatic cleanup now dynamically tracks and cleans custom screenshot directories used during the session.

### Removed
- **`browser_connect`**: Removed the remote debugging connection tool to focus on built-in automation.

### Fixed
- **Build Stability**: Fixed TypeScript errors related to browser process PID tracking.

## [1.4.0] - 2026-02-13

### Added
- **Deep Research Suite**: Transformed the server into a high-performance research tool with advanced browser automation.
- **Multi-Tab Management**: Added a `browser_tabs` system supporting up to 10 concurrent tabs with automatic LRU (Least Recently Used) rotation.
- **Parallel Operations**:
    - `multi_search`: Perform multiple Google searches in parallel.
    - `batch_navigate`: Navigate to multiple URLs simultaneously in separate tabs.
- **Anti-HTML Spam Snapshot**: `browser_snapshot` now returns a compact, tree-like accessibility snapshot with `ref` IDs for efficient AI interaction instead of raw HTML.
- **Advanced Browser Automation**:
    - `browser_action`: Support for `click`, `type`, `scroll`, `press_key`, `hover`, and `waitForSelector`.
    - `browser_wait_for`: Wait for specific text to appear or disappear.
    - `browser_links`: Extract all valid links from the current page.
- **Chrome DevTools Integration**:
    - `browser_network_requests`: Capture and inspect network traffic (XHR/Fetch).
    - `browser_console_messages`: Access browser console logs for debugging.
    - `browser_configure`: Configure Proxy, User-Agent, and Viewport settings.
- **Resource Management**:
    - **Idle Timeout**: Browser process automatically closes after 1 minute of inactivity to save resources.
    - `browser_close`: Manual tool to terminate the browser instance.
- **Enhanced Media & Document Support**:
    - `take_screenshot`: Full-page screenshots with a 5-day automatic cleanup lifecycle.
    - `parse_document`: Extract text content from PDF and DOCX URLs.
- **Restored Legacy Tools**: Re-integrated `google_search`, `download_file`, and `smart_command` into the new architecture.

### Changed
- Refactored core architecture to use a persistent browser instance with tab-aware state management.
- Improved error handling and logging for Puppeteer operations.

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
