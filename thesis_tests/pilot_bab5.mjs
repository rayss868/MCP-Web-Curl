import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
const ROOT='http://127.0.0.1:8123';
const out=[];
const transport=new StdioClientTransport({command:'node',args:['build/index.js'],env:process.env,stderr:'ignore'});
const client=new Client({name:'bab5-pilot',version:'1.0.0'},{capabilities:{}});
await client.connect(transport);
const textOf=r=>(r?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
async function test(name, tool, args, check=()=>true){
  const t0=performance.now();
  try { const r=await client.callTool({name:tool,arguments:args}); const text=textOf(r); const ok=!r.isError && check(text,r); out.push({name,tool,ok,isError:!!r.isError,latency_ms:performance.now()-t0,output_chars:text.length,sample:text.slice(0,240)}); }
  catch(e){ out.push({name,tool,ok:false,isError:true,latency_ms:performance.now()-t0,output_chars:0,error:String(e?.message||e)}); }
}
await test('browser_basic','browser_flow',{url:ROOT+'/html/basic',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},t=>t.includes('BROWSER_MARKER_RAYHAN_2026'));
await test('browser_action_click','browser_flow',{url:ROOT+'/html/basic',waitForNetworkIdle:false,stabilizeMs:0,actions:[{action:'click',selector:'#btn'}],result:{type:'snapshot',mode:'tree'}},t=>t.includes('clicked'));
await test('api_normal','fetch_api',{url:ROOT+'/api/json',method:'GET',limit:2000},t=>t.includes('API_MARKER_RAYHAN_2026'));
await test('api_output_limit','fetch_api',{url:ROOT+'/api/large',method:'GET',limit:100},t=>t.includes('"truncated": true'));
await test('api_forced_timeout','fetch_api',{url:ROOT+'/api/delay?ms=500',method:'GET',limit:2000,timeout:50},t=>t.toLowerCase().includes('timed out'));
const dlDir=path.join(process.cwd(),'thesis_tests','downloads'); fs.mkdirSync(dlDir,{recursive:true});
await test('download_file','download_file',{url:ROOT+'/files/sample.txt',destinationFolder:'thesis_tests/downloads',filename:'pilot_sample.txt'},()=>fs.existsSync(path.join(dlDir,'pilot_sample.txt')));
await test('parse_pdf','parse_document',{url:ROOT+'/files/sample.pdf'},t=>t.includes('PDF_MARKER_RAYHAN_2026'));
await test('parse_docx','parse_document',{url:ROOT+'/files/sample.docx'},t=>t.includes('DOCX_MARKER_RAYHAN_2026'));
await test('multi_search','multi_search',{queries:['Model Context Protocol OpenAI']},t=>t.includes('results'));
await test('session_set','browser_flow',{url:ROOT+'/session/set',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},t=>t.includes('SESSION_SET'));
await test('browser_close_mid','browser_close',{},t=>t.includes('Browser closed'));
await test('session_reuse','browser_flow',{url:ROOT+'/session/check',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},t=>t.includes('SESSION_MARKER_RAYHAN_2026')&&t.includes('LOCAL_MARKER_RAYHAN_2026'));
for(let i=0;i<12;i++) await test('tab_create_'+(i+1),'browser_flow',{url:ROOT+'/html/basic?tab='+i,newTab:true,waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},t=>t.includes('BROWSER_MARKER_RAYHAN_2026'));
await test('tab_list_after_12','browser_tabs',{action:'list'},t=>{try{return JSON.parse(t).length===10}catch{return false}});
await test('browser_close_final','browser_close',{},t=>t.includes('Browser closed'));
fs.writeFileSync(path.join(process.cwd(),'thesis_tests','pilot_results.json'),JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
await client.close();