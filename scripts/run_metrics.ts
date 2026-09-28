import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// --- Configuration ---
const MCP_SERVER_CMD = process.env.MCP_SERVER_CMD || 'node build/index.js';
const RUNS = parseInt(process.env.RUNS || '5', 10);
const MAX_CHARS = parseInt(process.env.MAX_CHARS || '800', 10);
const TIMEOUT_MS_NORMAL = parseInt(process.env.TIMEOUT_MS_NORMAL || '8000', 10);
const TIMEOUT_MS_FORCED = parseInt(process.env.TIMEOUT_MS_FORCED || '50', 10);

const METRICS_DIR = path.join(process.cwd(), 'metrics');
const SUMMARY_FILE = path.join(METRICS_DIR, 'metrics_summary.json');
const CSV_FILE = path.join(METRICS_DIR, 'metrics_runs.csv');

// --- Types ---
interface MetricRun {
  scenario_id: string;
  success: boolean;
  truncation: boolean;
  timeout: boolean;
  error: boolean;
  tool_calls: number;
  latency_ms: number;
  error_message?: string;
}

interface Scenario {
  id: string;
  name: string;
  run: (client: Client) => Promise<MetricRun>;
}

// --- Helper Functions ---

// Helper to parse command string into command and args
function parseCommand(cmd: string): [string, string[]] {
  const parts = cmd.split(' ');
  return [parts[0], parts.slice(1)];
}

// Helper to detect truncation in tool result
function isTruncated(result: any): boolean {
  if (!result || !result.content || !Array.isArray(result.content)) return false;

  for (const item of result.content) {
    if (item.type === 'text') {
      try {
        const data = JSON.parse(item.text);
        // Check for common truncation fields
        if (data.truncated === true) return true;
        if (data.is_truncated === true) return true;
        if (data.truncation === true) return true;
        // fetch_api reports a limit plus the measured payload size
        if (typeof data.limit === 'number' && typeof data.body === 'string' && data.body.length >= data.limit) return true;
        // browser_snapshot html mode reports remainingCharacters > 0
        if (typeof data.remainingCharacters === 'number' && data.remainingCharacters > 0) return true;
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }
  return false;
}

// Helper to detect a capped main-content field in an extract response
function isMainContentCapped(result: any, maxTextChars: number): boolean {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return false;
  try {
    const data = JSON.parse(text);
    return typeof data.mainContent === 'string' && data.mainContent.length >= maxTextChars;
  } catch (e) {
    return false;
  }
}

// --- Scenarios ---

const scenarios: Scenario[] = [
  {
    id: 'S1',
    name: 'Documentation reading',
    run: async (client) => {
      const start = performance.now();
      let toolCalls = 0;
      let truncation = false;
      let success = false;
      let error = false;
      let timeout = false;
      let errorMessage = '';

      try {
        // Step 1: Google Search
        toolCalls++;
        const searchResult = await client.callTool({
          name: 'multi_search',
          arguments: {
            queries: ['web scraping best practices']
          }
        }, CallToolResultSchema);

        const searchContent = JSON.parse((searchResult as any).content[0].text);
        // multi_search returns one entry per query: [{ query, results: [{ title, link, snippet }] }]
        const firstQuery = Array.isArray(searchContent) ? searchContent[0] : undefined;
        const firstHit = firstQuery?.results?.[0];
        const targetUrl = firstHit?.link || '';

        if (!targetUrl) {
          throw new Error('No URL found in search results');
        }

        // Step 2: Extract structured content from the page
        toolCalls++;
        const extractResult = await client.callTool({
          name: 'extract',
          arguments: {
            url: targetUrl,
            includeTables: false,
            includeJsonLd: false,
            maxTextChars: MAX_CHARS
          }
        }, CallToolResultSchema);

        truncation = isMainContentCapped(extractResult, MAX_CHARS);
        success = !(extractResult as any).isError;
        if (!success) error = true;

      } catch (e: any) {
        error = true;
        success = false;
        errorMessage = e.message;
        if (e.message && e.message.includes('timeout')) timeout = true;
      }

      const end = performance.now();
      return {
        scenario_id: 'S1',
        success,
        truncation,
        timeout,
        error,
        tool_calls: toolCalls,
        latency_ms: end - start,
        error_message: errorMessage
      };
    }
  },
  {
    id: 'S2_Normal',
    name: 'REST API inspection (Normal)',
    run: async (client) => {
      const start = performance.now();
      let toolCalls = 0;
      let truncation = false;
      let success = false;
      let error = false;
      let timeout = false;
      let errorMessage = '';

      try {
        toolCalls++;
        // Using a public API that should respond quickly
        const result = await Promise.race([
            client.callTool({
                name: 'fetch_api',
                arguments: {
                    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
                    method: 'GET',
                    limit: 10000,
                    timeout: TIMEOUT_MS_NORMAL
                }
            }, CallToolResultSchema),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Client timeout')), TIMEOUT_MS_NORMAL + 1000))
        ]);

        truncation = isTruncated(result);
        success = !(result as any).isError;
        if (!success) error = true;

      } catch (e: any) {
        error = true;
        success = false;
        errorMessage = e.message;
        if (e.message && (e.message.includes('timeout') || e.message.includes('timed out'))) timeout = true;
      }

      const end = performance.now();
      return {
        scenario_id: 'S2_Normal',
        success,
        truncation,
        timeout,
        error,
        tool_calls: toolCalls,
        latency_ms: end - start,
        error_message: errorMessage
      };
    }
  },
  {
    id: 'S2_Timeout',
    name: 'REST API inspection (Forced Timeout)',
    run: async (client) => {
      const start = performance.now();
      let toolCalls = 0;
      let truncation = false;
      let success = false;
      let error = false;
      let timeout = false;
      let errorMessage = '';

      try {
        toolCalls++;
        // Use a delay service to guarantee timeout
        // Request delay of 2 seconds, but set timeout to small value (default 50ms)
        const result = await client.callTool({
            name: 'fetch_api',
            arguments: {
                url: 'https://httpbin.org/delay/2',
                method: 'GET',
                limit: 10000,
                timeout: TIMEOUT_MS_FORCED
            }
        }, CallToolResultSchema);
        
        // The tool catches errors and returns isError: true
        if ((result as any).isError) {
            error = true;
            success = false; // "Success" of the tool execution is false because it timed out
            
            // Extract error message from content
            const content = (result as any).content[0]?.text || '';
            errorMessage = content;
            if (content.includes('timeout') || content.includes('timed out')) {
                timeout = true;
            }
        } else {
            // If it didn't error, the timeout was missed (bad test condition)
            success = true;
            errorMessage = "Did not timeout as expected";
        }

      } catch (e: any) {
        // Fallback if it actually throws
        error = true;
        success = false;
        errorMessage = e.message;
        if (e.message && (e.message.includes('timeout') || e.message.includes('timed out'))) {
            timeout = true;
        }
      }

      const end = performance.now();
      return {
        scenario_id: 'S2_Timeout',
        success,
        truncation,
        timeout,
        error,
        tool_calls: toolCalls,
        latency_ms: end - start,
        error_message: errorMessage
      };
    }
  },
  {
    id: 'S3',
    name: 'File retrieval',
    run: async (client) => {
      const start = performance.now();
      let toolCalls = 0;
      let truncation = false;
      let success = false;
      let error = false;
      let timeout = false;
      let errorMessage = '';
      const destFolder = 'temp_test_downloads';

      try {
        toolCalls++;
        // Using a small, stable file
        const result = await client.callTool({
          name: 'download_file',
          arguments: {
            url: 'https://www.google.com/robots.txt', // Stable text file
            destinationFolder: destFolder
          }
        }, CallToolResultSchema);

        success = !(result as any).isError;
        if (!success) {
            error = true;
            errorMessage = (result as any).content?.[0]?.text || 'Unknown error';
        }

        // Cleanup
        try {
            const filePath = path.join(process.cwd(), destFolder, 'iso_8859-1.txt');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(path.join(process.cwd(), destFolder))) fs.rmdirSync(path.join(process.cwd(), destFolder));
        } catch (cleanupErr) {
            // Ignore cleanup errors
        }

      } catch (e: any) {
        error = true;
        success = false;
        errorMessage = e.message;
        if (e.message && e.message.includes('timeout')) timeout = true;
      }

      const end = performance.now();
      return {
        scenario_id: 'S3',
        success,
        truncation,
        timeout,
        error,
        tool_calls: toolCalls,
        latency_ms: end - start,
        error_message: errorMessage
      };
    }
  }
];

// --- Main Execution ---

async function main() {
  console.log('Starting MCP-Web-Curl Metrics Harness...');
  console.log(`Configuration: RUNS=${RUNS}, MAX_CHARS=${MAX_CHARS}, TIMEOUT_NORMAL=${TIMEOUT_MS_NORMAL}, TIMEOUT_FORCED=${TIMEOUT_MS_FORCED}`);
  console.log(`Server Command: ${MCP_SERVER_CMD}`);

  // Initialize CSV
  if (!fs.existsSync(METRICS_DIR)) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  }
  fs.writeFileSync(CSV_FILE, 'scenario_id,success,truncation,timeout,error,tool_calls,latency_ms,error_message\n');

  const allRuns: MetricRun[] = [];

  // Start MCP Server
  const [cmd, args] = parseCommand(MCP_SERVER_CMD);
  
  // We need to run the server process
  // Note: StdioClientTransport expects a transport object, not just a command.
  // We need to spawn the process and pass stdin/stdout to the transport.
  
  console.log('Initializing StdioClientTransport...');

  // StdioClientTransport constructor takes (command, args) OR a config object.
  // But since we are managing the process ourselves to capture logs/stderr,
  // we need to pass the streams directly.
  // The SDK's StdioClientTransport might not expose stream injection easily in constructor.
  // Let's try to use the constructor that takes command and args, but that spawns its own process.
  // Wait, looking at SDK source, StdioClientTransport constructor signature is:
  // constructor(config: StdioServerParameters)
  // interface StdioServerParameters { command: string; args?: string[]; env?: Record<string, string>; stderr?: "inherit" | "ignore"; }
  // It seems StdioClientTransport is designed to spawn the process itself.
  
  // Let's switch to letting StdioClientTransport spawn the process.
  // We lose direct access to the process object for custom stdio handling if we wanted to pipe it elsewhere,
  // but for this harness, letting the SDK handle it is safer and correct.
  
  const transport = new StdioClientTransport({
    command: cmd,
    args: args,
    env: process.env as Record<string, string>,
    stderr: 'inherit' // Inherit stderr so we can see server logs in the harness output
  });

  const client = new Client({
    name: 'metrics-harness',
    version: '1.0.0',
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    console.log('Connected to MCP Server.');

    // Run Scenarios
    for (let i = 0; i < RUNS; i++) {
      console.log(`\n--- Run ${i + 1}/${RUNS} ---`);
      for (const scenario of scenarios) {
        console.log(`Running Scenario: ${scenario.name} (${scenario.id})...`);
        const result = await scenario.run(client);
        allRuns.push(result);
        
        // Log to CSV
        const csvLine = `${result.scenario_id},${result.success},${result.truncation},${result.timeout},${result.error},${result.tool_calls},${result.latency_ms.toFixed(2)},"${(result.error_message || '').replace(/"/g, '""')}"\n`;
        fs.appendFileSync(CSV_FILE, csvLine);
        
        console.log(`  Result: Success=${result.success}, Latency=${result.latency_ms.toFixed(2)}ms`);
        if (!result.success) {
            console.log(`  Error: ${result.error_message}`);
        }
      }
    }

  } catch (error) {
    console.error('Fatal Error:', error);
  } finally {
    // Cleanup
    await client.close();
    // Transport close should kill the process
    console.log('\nMetrics collection complete.');
  }

  // Generate Summary
  const summary: Record<string, any> = {};
  const scenarioIds = [...new Set(allRuns.map(r => r.scenario_id))];

  for (const id of scenarioIds) {
    const runs = allRuns.filter(r => r.scenario_id === id);
    const latencies = runs.map(r => r.latency_ms);
    
    summary[id] = {
      total_runs: runs.length,
      success_count: runs.filter(r => r.success).length,
      truncation_count: runs.filter(r => r.truncation).length,
      error_count: runs.filter(r => r.error).length,
      timeout_count: runs.filter(r => r.timeout).length,
      avg_tool_calls: runs.reduce((acc, r) => acc + r.tool_calls, 0) / runs.length,
      latency: {
        min: Math.min(...latencies),
        max: Math.max(...latencies),
        avg: latencies.reduce((a, b) => a + b, 0) / latencies.length
      }
    };
  }

  // Add totals
  summary['TOTALS'] = {
    total_runs: allRuns.length,
    success_count: allRuns.filter(r => r.success).length,
    truncation_count: allRuns.filter(r => r.truncation).length,
    error_count: allRuns.filter(r => r.error).length,
    timeout_count: allRuns.filter(r => r.timeout).length
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log(`Summary written to ${SUMMARY_FILE}`);
  console.log(`Detailed runs written to ${CSV_FILE}`);
}

main().catch(console.error);