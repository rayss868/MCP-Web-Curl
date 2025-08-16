### Google Custom Search API

Google Custom Search API is free with usage limits (e.g., 100 queries per day for free, with additional queries requiring payment). For full details on quotas, pricing, and restrictions, see the [official documentation](https://developers.google.com/custom-search/v1/overview).

# Web-curl

<div align="center">

![Web-curl Logo](image/R-Web-Curl.png)

</div>

**Developed by Rayss**

> 🚀 **Open Source Project**  
> 🛠️ Built with Node.js & TypeScript (Node.js v18+ required)

---

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-success)

</div>

---

<div align="center">
  <a href="https://github.com/rayss868/MCP-Web-Curl">
    <img width="380" height="200" src="https://glama.ai/mcp/servers/@rayss868/MCP-Web-Curl/badge" alt="Web-curl Server MCP server" />
  </a>
</div>

---

## 🎬 Demo Video

[![Watch the demo](https://img.shields.io/badge/Video-Demo-blue?logo=playstation)](demo/demo.mp4)

> [Click here to watch the demo video directly in your browser.](demo/demo.mp4)

If your platform supports it, you can also [download and play demo/demo.mp4](demo/demo.mp4) directly.

---

## 📚 Table of Contents

- [Changelog / Update History](#changelog)
- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
  - [CLI Usage](#cli-usage)
  - [MCP Server Usage](#mcp-server-usage)
- [Configuration](#configuration)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Tips & Best Practices](#tips--best-practices)
- [Contributing & Issues](#contributing--issues)
- [License & Attribution](#license--attribution)

---

<a name="changelog"></a>
## 📝 Changelog / Update History

See [CHANGELOG.md](CHANGELOG.md) for a complete history of updates and new features.

<a name="overview"></a>
## 📝 Overview

**Web-curl** is a powerful tool for fetching and extracting text content from web pages and APIs. Use it as a standalone CLI or as an MCP (Model Context Protocol) server. Web-curl leverages Puppeteer for robust web scraping and supports advanced features such as resource blocking, custom headers, authentication, and Google Custom Search.

---
<a name="features"></a>

## ✨ Features

### Storage & Download Details

- 🗂️ Error log rotation: `logs/error-log.txt` is rotated when it exceeds ~1MB (renamed to `error-log.txt.bak`) to prevent unbounded growth.
- 🧹 Logs & temp cleanup: old temporary files in the `logs/` directory are cleaned up at startup.
- 🛑 Browser lifecycle: Puppeteer browser instances are closed in finally blocks to avoid Chromium temp file leaks.
- 🔎 Content extraction:
  - Returns raw text, HTML, and Readability "main article" when available.
  - Readability output is subject to `startIndex`/`maxLength`/`chunkSize` slicing when requested.
- 🚫 Resource blocking: images, stylesheets, and fonts can be blocked for faster page loads.
- ⏱️ Timeout control: navigation and API request timeouts are configurable via tool arguments.
- 💾 Output: results can be printed to stdout or written to a file via CLI options.
- ⬇️ Download behavior (`download_file`):
  - `destinationFolder` accepts relative paths (resolved against `process.cwd()`) or absolute paths.
  - The server creates `destinationFolder` if it does not exist.
  - Downloads are streamed using Node streams + `pipeline` to minimize memory use and ensure robust writes.
  - Filenames are derived from the URL path (e.g., `https://.../path/file.jpg` -> `file.jpg`). If no filename is present, the fallback name is `downloaded_file`.
  - Overwrite semantics: by default the implementation will overwrite an existing file with the same name. To avoid overwrite, provide a unique `destinationFolder` or include a unique filename (timestamp, uuid) in the URL path or destination prior to calling the tool. (Optionally the code can be extended to support a `noOverwrite` flag to auto-rename files—ask if you want this implemented.)
  - Error handling: non-2xx responses cause a thrown error; partial writes are avoided by streaming through `pipeline` and only returning the final path on success.
- 🖥️ Usage modes: CLI and MCP server (stdin/stdout transport).
- 🌐 REST client: `fetch_api` returns JSON/text when appropriate and base64 for binary responses.
- Note: `fetch_api` now requires a numeric `limit` parameter; responses will be truncated to at most `limit` characters. The response object includes `bodyLength` (original length in characters) and `truncated` (boolean).
- `fetch_api` is marked `autoApprove` in the MCP tool listing so compatible MCP hosts may invoke it without interactive approval. Internal calls in this codebase use a sensible default `limit` of 1000 characters where applicable.
- 🔍 Google Custom Search: requires `APIKEY_GOOGLE_SEARCH` and `CX_GOOGLE_SEARCH`.
- 🤖 Smart command:
  - Auto language detection (franc-min) and optional translation (dynamic `translate` import). Translation is a best-effort fallback and may fail silently; original text is preserved on failure.
  - Query enrichment is heuristic-based; results depend on the detected intent.
- 📄 fetch_webpage specifics:
  - Multi-page crawling via `nextPageSelector` (tries href first, falls back to clicking the element).
  - Use `chunkSize` + `chunkOverlap` for deterministic chunking; legacy `maxLength` is still supported but `chunkSize` is preferred.
  - Required parameters: `startIndex` (or alias `index`) and at least one of `chunkSize` (preferred), `limit` (alias), or `maxLength` must be provided and be a number. Calls missing these required parameters will be rejected with an InvalidParams error. Set these values according to your needs; they may not be empty.
  - Validation behavior: runtime validation is enforced in `src/index.ts` and the MCP tool will throw/reject when required parameters are missing or invalid. If you prefer automatic fallbacks instead of rejection, modify the validation logic in `src/index.ts`.
- 🛡️ Debug & Logging
  - Runtime logs: detailed runtime errors and debug traces are written to `logs/error-log.txt` by default.
  - Debug flag: some CLI/tool paths accept a `debug` argument which enables more verbose console logging; not all code paths consistently honor a `debug` flag yet. Prefer inspecting `logs/error-log.txt` for complete traces.
  - To enable console-level debug consistently, a small code change to read a `DEBUG=true` env var or a global `--debug` CLI option can be added (recommended for development).
- ⚙️ Compatibility & Build notes
  - The project currently depends on `node-fetch` but targets Node 18+, which provides a global `fetch`. Consider replacing `node-fetch` with the global `fetch` to remove the dependency and avoid cross-version issues.
  - `npm run build` runs `tsc` and a `chmod` step that is no-op on Windows; CI or cross-platform scripts should guard `chmod` with a platform check.
- 🔐 Security considerations
  - SSRF: validate/whitelist destination hosts if exposing `fetch_api`/`fetch_webpage` publicly.
  - Rate limiting & auth: add request rate limiting and access controls for public deployments.
  - Puppeteer flags: `--no-sandbox` reduces isolation; only use it where required and understand the risk on multi-tenant systems.
- 🧪 Tests & linting
  - Linting: `npm run lint` is provided; include a pre-commit hook (husky) to enforce linting in CI.
  - Tests: no unit tests are included yet. Adding simple integration tests for `fetch_api` and `download_file` is recommended.
- 📑 All tool schemas and documentation are in English for clarity.

---

<a name="architecture"></a>
## 🏗️ Architecture

- **CLI & MCP Server**: [`src/index.ts`](src/index.ts)  
  Implements both the CLI entry point and the MCP server, exposing tools like `fetch_webpage`, `fetch_api`, `google_search`, and `smart_command`.
- **Web Scraping**: Uses Puppeteer for headless browsing, resource blocking, and content extraction.
- **REST Client**: [`src/rest-client.ts`](src/rest-client.ts)  
  Provides a flexible HTTP client for API requests, used by both CLI and MCP tools.
- **Configuration**: Managed via CLI options, environment variables, and tool arguments.
  - Note: the server creates `logs/` at startup and resolves relative paths against `process.cwd()`. Tools exposed include `download_file` (streaming writes), `fetch_webpage`, `fetch_api`, `google_search`, and `smart_command`.

---
<a name="installation"></a>

## ⚙️ MCP Server Configuration Example

To integrate web-curl as an MCP server, add the following configuration to your `mcp_settings.json`:

```json
{
  "mcpServers": {
    "web-curl": {
      "command": "node",
      "args": [
        "build/index.js"
      ],
      "disabled": false,
      "alwaysAllow": [
        "fetch_webpage",
        "fetch_api",
        "google_search",
        "smart_command",
        "download_file"
      ],
      "env": {
        "APIKEY_GOOGLE_SEARCH": "YOUR_GOOGLE_API_KEY",
        "CX_GOOGLE_SEARCH": "YOUR_CX_ID"
      }
    }
  }
}
```

---

### 🔑 How to Obtain Google API Key and CX

1. **Get a Google API Key:**  
   - Go to [Google Cloud Console](https://console.cloud.google.com/).
   - Create/select a project, then go to **APIs & Services > Credentials**.
   - Click **Create Credentials > API key** and copy it.

2. **Get a Custom Search Engine (CX) ID:**  
   - Go to [Google Custom Search Engine](https://cse.google.com/cse/all).
   - Create/select a search engine, then copy the **Search engine ID** (CX).

3. **Enable Custom Search API:**  
   - In Google Cloud Console, go to **APIs & Services > Library**.
   - Search for **Custom Search API** and enable it.

Replace `YOUR_GOOGLE_API_KEY` and `YOUR_CX_ID` in the config above.

---

<a name="installation"></a>
## 🛠️ Installation

```bash
# Clone the repository
git clone https://github.com/rayss868/MCP-Web-Curl
cd web-curl

# Install dependencies
npm install

# Build the project
npm run build
```

### Puppeteer installation notes

- **Windows:** Just run `npm install`.
- **Linux:** You must install extra dependencies for Chromium. Run:

  ```bash
  sudo apt-get install -y \
    ca-certificates fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils
  ```

  For more details, see the [Puppeteer troubleshooting guide](https://pptr.dev/troubleshooting).

---

<a name="usage"></a>
## 🚀 Usage

### CLI Usage

The CLI supports fetching and extracting text content from web pages.

```bash
# Basic usage
node build/index.js https://example.com

# With options
node build/index.js --timeout 30000 --no-block-resources https://example.com

# Save output to a file
node build/index.js -o result.json https://example.com
```

#### Command Line Options

- `--timeout <ms>`: Set navigation timeout (default: 60000)
- `--no-block-resources`: Disable blocking of images, stylesheets, and fonts
- `-o <file>`: Output result to specified file

### MCP Server Usage

Web-curl can be run as an MCP server for integration with Roo Context or other MCP-compatible environments.

#### Exposed Tools

- **fetch_webpage**: Retrieve text, html, main article content, and metadata from a web page. Supports multi-page crawling (pagination) and debug mode.
- **fetch_api**: Make REST API requests with custom methods, headers, body, timeout, and debug mode.
- **google_search**: Search the web using Google Custom Search API, with advanced filters (language, region, site, dateRestrict) and debug mode.
- **smart_command**: Free-form command with automatic language detection, translation, query enrichment, and debug mode.
- **download_file**: Download a file from a given URL to a specified folder.

#### Running as MCP Server

```bash
npm run start
```

The server will communicate via stdin/stdout and expose the tools as defined in [`src/index.ts`](src/index.ts:42).

#### MCP Tool Example (fetch_webpage)

```json
{
  "name": "fetch_webpage",
  "arguments": {
    "url": "https://example.com",
    "blockResources": true,
    "timeout": 60000,
    "maxLength": 10000
  }
}
```

---

### 🚦 Chunked Fetch Example (Recommended for Large Pages)

For large documents use deterministic chunking with `chunkSize` and `chunkOverlap`. The server supports `chunkSize` (preferred) and `chunkOverlap` to preserve context between chunks. Example workflow:

Client request for first chunk:
```json
{
  "name": "fetch_webpage",
  "arguments": {
    "url": "https://example.com/long-article",
    "blockResources": true,
    "timeout": 60000,
    "chunkSize": 2000,     // number of characters per chunk
    "chunkOverlap": 200,   // overlap between chunks to preserve context
    "startIndex": 0
  }
}
```

Server response (example):
```json
{
  "text": "First 2000 characters...",
  "startIndex": 0,
  "nextStartIndex": 1800,   // nextStartIndex = startIndex + (chunkSize - chunkOverlap)
  "chunkSize": 2000,
  "chunkOverlap": 200,
  "isLastChunk": false
}
```

Client fetches the next chunk by setting `startIndex` to `nextStartIndex`:
```json
{
  "name": "fetch_webpage",
  "arguments": {
    "url": "https://example.com/long-article",
    "chunkSize": 2000,
    "chunkOverlap": 200,
    "startIndex": 1800
  }
}
```

- Continue until `isLastChunk: true`.
- Reassemble the full content by concatenating each `text` in order, trimming the overlapped region if desired (or keeping overlaps if you prefer redundant context).
- Notes:
  - `chunkSize`/`chunkOverlap` operate on characters (deterministic) in the current implementation.
  - If `chunkSize` is not provided, legacy `maxLength`/`startIndex` slicing is used.
  - The server returns `nextStartIndex` and `isLastChunk` to make client loop logic simple and deterministic.

#### Google Search Integration

Set the following environment variables for Google Custom Search:

- `APIKEY_GOOGLE_SEARCH`: Your Google API key
- `CX_GOOGLE_SEARCH`: Your Custom Search Engine ID

---

<a name="configuration"></a>
## 🧩 Configuration

- **Resource Blocking**: Block images, stylesheets, and fonts for faster page loading.
- **Timeout**: Set navigation and API request timeouts.
- **Custom Headers**: Pass custom HTTP headers for advanced scenarios.
- **Authentication**: Supports HTTP Basic Auth via username/password.
- **Environment Variables**: Used for Google Search API integration.

---

<a name="examples"></a>
## 💡 Examples

<details>
<summary>Fetch Webpage Content (with main article extraction and multi-page crawling)</summary>

```json
{
  "name": "fetch_webpage",
  "arguments": {
    "url": "https://en.wikipedia.org/wiki/Web_scraping",
    "blockResources": true,
    "maxLength": 5000,
    "nextPageSelector": ".pagination-next a",
    "maxPages": 3,
    "debug": true
  }
}
```
</details>

<details>
<summary>Make a REST API Request</summary>

```json
{
  "name": "fetch_api",
  "arguments": {
    "url": "https://api.github.com/repos/nodejs/node",
    "method": "GET",
    "headers": {
      "Accept": "application/vnd.github.v3+json"
    }
  }
}
```
</details>

<details>
<summary>Google Search (with advanced filters)</summary>

```json
{
  "name": "google_search",
  "arguments": {
    "query": "web scraping best practices",
    "num": 5,
    "language": "lang_en",
    "region": "US",
    "site": "wikipedia.org",
    "dateRestrict": "w1",
    "debug": true
  }
}
```
</details>

<details>
<summary>Download File</summary>

```json
{
  "name": "download_file",
  "arguments": {
    "url": "https://example.com/image.jpg",
    "destinationFolder": "downloads"
  }
}
```

Note: `destinationFolder` can be either a relative path (resolved against the current working directory, `process.cwd()`) or an absolute path. The server will create the destination folder if it does not exist.
</details>

---
<a name="troubleshooting"></a>
## 🛠️ Troubleshooting

- **Timeout Errors**: Increase the `timeout` parameter if requests are timing out.
- **Blocked Content**: If content is missing, try disabling resource blocking or adjusting `resourceTypesToBlock`.
- **Google Search Fails**: Ensure `APIKEY_GOOGLE_SEARCH` and `CX_GOOGLE_SEARCH` are set in your environment.
- **Binary/Unknown Content**: Non-text responses are base64-encoded.
- **Error Logs**: Check the `logs/error-log.txt` file for detailed error messages.

---

<a name="tips--best-practices"></a>
## 🧠 Tips & Best Practices

<details>
<summary>Click for advanced tips</summary>

- Use resource blocking for faster and lighter scraping unless you need images or styles.
- For large pages, use `maxLength` and `startIndex` to paginate content extraction.
- Always validate your tool arguments to avoid errors.
- Secure your API keys and sensitive data using environment variables.
- Review the MCP tool schemas in [`src/index.ts`](src/index.ts) for all available options.

</details>

---

<a name="contributing--issues"></a>
## 🤝 Contributing & Issues

Contributions are welcome! If you want to contribute, fork this repository and submit a pull request.  
If you find any issues or have suggestions, please open an issue on the repository page.

---

<a name="license--attribution"></a>
## 📄 License & Attribution

This project was developed by **Rayss**.  
For questions, improvements, or contributions, please contact the author or open an issue in the repository.

---
> **Note:** Google Search API is free with usage limits. For details, see: [Google Custom Search API Overview](https://developers.google.com/custom-search/v1/overview)
