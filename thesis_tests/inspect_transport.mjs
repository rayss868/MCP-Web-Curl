import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({command:'node',args:['build/index.js'],env:process.env,stderr:'ignore'});
const c = new Client({name:'inspect',version:'1.0'},{capabilities:{}});
await c.connect(t);
console.log('keys', Object.keys(t));
console.log('pid', t._process?.pid, t.process?.pid, t._process);
await c.close();