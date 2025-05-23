# Web-curl

![Web-curl Logo](image/R-Web-Curl.png)

**Developed by Rayss**

> 🚀 **Open Source Project**  
> 🛠️ Built with Node.js & TypeScript (Node.js v18+ required)

---

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-success)

---

## 🎬 Demo Video

<video src="demo/demo.mp4" controls width="600"></video>

[![Watch the demo](https://img.shields.io/badge/Video-Demo-blue?logo=playstation)](demo/demo.mp4)

<details>
<summary>Click to watch the demo directly in your browser</summary>

[Demo Video (MP4)](demo/demo.mp4)

</details>

---

## 📚 Table of Contents

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

## 📝 Overview

**Web-curl** is a powerful tool for fetching and extracting text content from web pages and APIs. Use it as a standalone CLI or as an MCP (Model Context Protocol) server. Web-curl leverages Puppeteer for robust web scraping and supports advanced features such as resource blocking, custom headers, authentication, and Google Custom Search.

---

## ✨ Features

- 🔎 Retrieve text content from any website.
- 🚫 Block unnecessary resources (images, stylesheets, fonts) for faster loading.
- ⏱️ Set navigation timeouts and content extraction limits.
- 💾 Output results to stdout or save to a file.
- 🖥️ Use as a CLI tool or as an MCP server.
- 🌐 Make REST API requests with custom methods, headers, and bodies.
- 🔍 Integrate Google Custom Search (requires API key and CX).
- 🤖 Smart command parsing (auto-detects URLs and search queries).
- 🛡️ Detailed error logging and robust error handling.

---

## 🏗️ Architecture

- **CLI & MCP Server**: [`src/index.ts`](src/index.ts:1)  
  Implements both the CLI entry point and the MCP server, exposing tools like `fetch_webpage`, `fetch_api`, `google_search`, and `smart_command`.
- **Web Scraping**: Uses Puppeteer for headless browsing, resource blocking, and content extraction.
- **REST Client**: [`src/rest-client.ts`](src/rest-client.ts:1)  
  Provides a flexible HTTP client for API requests, used by both CLI and MCP tools.
- **Configuration**: Managed via CLI options, environment variables, and tool arguments.

---

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
        "smart_command"
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

## 🛠️ Installation

```bash
# Clone the repository
git clone <repository-url>
cd web-curl

# Install dependencies
npm install

# Build the project
npm run build
```

---

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

Web-curl can be run as an MCP server for integration with Roo Code or other MCP-compatible platforms.

#### Exposed Tools

- **fetch_webpage**: Retrieve text content from a web page
- **fetch_api**: Make REST API requests
- **google_search**: Search the web using Google Custom Search API
- **smart_command**: Accepts natural language commands and auto-routes to the appropriate tool

#### Running as MCP Server

```bash
npm run start
```

The server communicates via stdio and exposes tools as defined in [`src/index.ts`](src/index.ts:42).

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

#### Google Search Integration

Set the following environment variables for Google Custom Search:

- `APIKEY_GOOGLE_SEARCH`: Your Google API key
- `CX_GOOGLE_SEARCH`: Your Custom Search Engine ID

---

## 🧩 Configuration

- **Resource Blocking**: Block images, stylesheets, and fonts for faster scraping.
- **Timeouts**: Set navigation and API request timeouts.
- **Custom Headers**: Pass custom HTTP headers for advanced scenarios.
- **Authentication**: Supports HTTP Basic Auth via username/password.
- **Environment Variables**: Used for Google Search API integration.

---

## 💡 Examples

<details>
<summary>Fetch Webpage Content</summary>

```json
{
  "name": "fetch_webpage",
  "arguments": {
    "url": "https://en.wikipedia.org/wiki/Web_scraping",
    "blockResources": true,
    "maxLength": 5000
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
<summary>Google Search</summary>

```json
{
  "name": "google_search",
  "arguments": {
    "query": "web scraping best practices",
    "num": 5
  }
}
```
</details>

---

## 🛠️ Troubleshooting

- **Timeout Errors**: Increase the `timeout` parameter if requests are timing out.
- **Blocked Content**: If content is missing, try disabling resource blocking or adjusting `resourceTypesToBlock`.
- **Google Search Fails**: Ensure `APIKEY_GOOGLE_SEARCH` and `CX_GOOGLE_SEARCH` are set in your environment.
- **Binary/Unknown Content**: Non-text responses are base64-encoded.
- **Error Logs**: Check the `logs/error-log.txt` file for detailed error messages.

---

## 🧠 Tips & Best Practices

<details>
<summary>Click for advanced tips</summary>

- Use resource blocking for faster and lighter scraping unless you need images or styles.
- For large pages, use `maxLength` and `startIndex` to paginate content extraction.
- Always validate your tool arguments to avoid errors.
- Secure your API keys and sensitive data using environment variables.
- Review the MCP tool schemas in [`src/index.ts`](src/index.ts:98) for all available options.

</details>

---

## 🤝 Contributing & Issues

Contributions are welcome! If you want to contribute, fork this repository and submit a pull request.  
If you find any issues or have suggestions, please open an issue on the repository page.

---

## 📄 License & Attribution

This project was developed by **Rayss**.  
For questions, improvements, or contributions, please contact the author or open an issue in the repository.

---