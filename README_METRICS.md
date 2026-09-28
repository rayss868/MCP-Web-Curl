# 📊 MCP-Web-Curl Automated Metrics Report

This document details the automated testing harness designed to validate the performance, reliability, and robustness of the `web-curl` MCP server.

## 🚀 Quick Start

Run the full test suite with a single command:

```bash
npm run metrics
```

This script will:
1.  **Spawn** a fresh instance of the MCP server.
2.  **Execute** a series of predefined scenarios (N runs each).
3.  **Collect** telemetry data (latency, success rates, errors).
4.  **Generate** detailed reports in the `metrics/` directory.

---

## 🧪 Test Scenarios

The harness executes the following scenarios to cover critical functionality:

### S1: Documentation Reading (Complex Workflow)
*   **Goal:** Simulate a user researching a topic.
*   **Flow:** `multi_search` ("web scraping best practices") → Parse first result → `extract` (Top Result).
*   **Validation:** Checks if content is returned and if the `maxTextChars` cap is applied (by setting a small `MAX_CHARS`).
*   **Metrics:** Latency of the full chain, cap detection.

### S2: REST API Inspection (Robustness)
*   **Mode A: Normal Operation**
    *   **Target:** Public API (CoinGecko).
    *   **Goal:** Verify fast, successful JSON fetching.
*   **Mode B: Forced Timeout**
    *   **Target:** Delay Service (`httpbin.org/delay/2`).
    *   **Goal:** Verify that the server correctly aborts requests that exceed the timeout limit (set to 50ms).
    *   **Expected Result:** `success: false`, `timeout: true`.

### S3: File Retrieval (Binary/Stream)
*   **Goal:** Verify file download capabilities.
*   **Flow:** `download_file` (Stable text file from Google) → Save to temp folder → Verify file existence → Cleanup.

---

## 📈 How to Read the Data

The harness outputs two files in the `metrics/` folder. Here is how to interpret them.

### 1. `metrics_summary.json` (High-Level Overview)

This JSON file provides aggregated statistics for each scenario.

**Example Structure:**
```json
"S2_Timeout": {
  "total_runs": 5,
  "success_count": 0,      // Should be 0 for timeout tests
  "timeout_count": 5,      // Should match total_runs
  "latency": {
    "avg": 65.94,          // Average duration in ms
    "min": 56.53,
    "max": 75.50
  }
}
```

**Key Metrics:**
*   **`success_count`**: Number of runs where the tool executed without throwing an error.
    *   *Note:* For **S2_Timeout**, a low success count is GOOD (it means the timeout error was correctly thrown).
*   **`truncation_count`**: How often the response was capped or cut off (expected for S1).
*   **`latency`**: Time taken from sending the request to receiving the response.

### 2. `metrics_runs.csv` (Detailed Logs)

This CSV file logs every single execution row-by-row. Import this into Excel or Google Sheets for analysis.

**Columns:**
*   `scenario_id`: ID of the test scenario (e.g., S1, S2_Normal).
*   `success`: `true` if the tool ran smoothly, `false` if it threw an error.
*   `truncation`: `true` if the content was truncated.
*   `timeout`: `true` if a timeout error was detected.
*   `error`: `true` if any error occurred.
*   `latency_ms`: Execution time in milliseconds.
*   `error_message`: The specific error returned (e.g., "Request timed out...").

---

## ⚙️ Configuration

You can customize the test parameters using environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_SERVER_CMD` | `node build/index.js` | Command to start the server. |
| `RUNS` | `5` | Number of iterations per scenario. |
| `MAX_CHARS` | `800` | Character cap for S1 main content (set via `extract`'s `maxTextChars`). |
| `TIMEOUT_MS_NORMAL` | `8000` | Timeout for normal API calls. |
| `TIMEOUT_MS_FORCED` | `50` | Timeout for forced timeout test. |

**Example:** Run 10 iterations with a stricter timeout:
```bash
RUNS=10 TIMEOUT_MS_FORCED=20 npm run metrics
```

---

## 📋 Methodology

The harness is built with **TypeScript** and uses the official **MCP SDK Client**.

1.  **Isolation:** The MCP server is spawned as a child process for each test suite run, ensuring a clean state.
2.  **Direct Connection:** The harness connects via `stdio` (Standard Input/Output), mimicking how an AI model or IDE would interact with the server.
3.  **Heuristic Detection:**
    *   **Truncation:** Detects flags like `truncated: true`, a `fetch_api` body that hit its `limit`, `remainingCharacters > 0` in a `browser_snapshot` html slice, or an `extract` `mainContent` that reached `maxTextChars`.
    *   **Timeout:** Parses error messages for keywords like "timeout" or "timed out".