import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'node', args: ['build/index.js'], env: process.env, stderr: 'ignore' });
const client = new Client({ name: 'thesis-introspect', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const result = await client.listTools();
console.log(JSON.stringify(result.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2));
await client.close();