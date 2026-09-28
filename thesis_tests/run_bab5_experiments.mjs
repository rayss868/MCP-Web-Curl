import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import 'dotenv/config';

const ROOT = 'http://127.0.0.1:8123';
const OUT = path.join(process.cwd(), 'thesis_tests', 'results');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(process.cwd(), 'thesis_tests', 'downloads'), { recursive: true });
const rows = [];
const rawEvidence = [];
const transport = new StdioClientTransport({ command:'node', args:['build/index.js'], env:process.env, stderr:'ignore' });
const client = new Client({ name:'bab5-experiment', version:'1.0.0' }, { capabilities:{} });
await client.connect(transport);
const serverPid = transport._process?.pid || 0;
const textOf = r => (r?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const isErrorText = t => /error|failed|timeout|timed out|invalid/i.test(t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getResourceSnapshot() {
  try {
    let browserPid = 0;
    const pidFile = path.join(process.cwd(), 'logs', 'browser.pid');
    if (fs.existsSync(pidFile)) browserPid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
    const roots = [serverPid, browserPid].filter(Boolean).join(',');
    if (!roots) return {};
    const ps = `$roots=@(${roots}); $all=Get-CimInstance Win32_Process; $pids=@(); function AddTree([int]$p){ if($script:pids -contains $p){return}; $script:pids += $p; foreach($c in $all | Where-Object {$_.ParentProcessId -eq $p}){ AddTree $c.ProcessId } }; foreach($r in $roots){AddTree $r}; $procs=Get-Process -Id $pids -ErrorAction SilentlyContinue; [pscustomobject]@{rss_mb=[math]::Round((($procs|Measure-Object WorkingSet64 -Sum).Sum/1MB),2); cpu_total_s=[math]::Round((($procs|Measure-Object CPU -Sum).Sum),4); process_count=@($procs).Count}|ConvertTo-Json -Compress`;
    return JSON.parse(execFileSync('powershell', ['-NoProfile','-Command',ps], {encoding:'utf8', timeout:10000}));
  } catch { return {}; }
}
function record(base) { rows.push({ timestamp:new Date().toISOString(), ...base }); }
function jsonMaybe(text) { try { return JSON.parse(text); } catch { return null; } }
async function callMeasured({scenario, category, condition='mcp', rep, tool, args, check, expectedError=false, resource=false, toolCalls=1}) {
  const t0 = performance.now();
  let result, text='', caught='';
  try { result = await client.callTool({ name:tool, arguments:args }); text = textOf(result); }
  catch (e) { caught = String(e?.message || e); text = caught; result = { isError:true }; }
  const latency = performance.now() - t0;
  const isErr = !!result?.isError || !!caught;
  let pass = false;
  try { pass = expectedError ? (isErr && check(text, result)) : (!isErr && check(text, result)); } catch { pass = false; }
  const parsed = jsonMaybe(text);
  const res = resource ? getResourceSnapshot() : {};
  record({scenario_id:scenario, category, condition, repetition:rep, success:pass, is_error:isErr, expected_error:expectedError, tool_calls:toolCalls, latency_ms:+latency.toFixed(3), output_chars:text.length, body_length:parsed?.bodyLength ?? parsed?.totalLength ?? '', truncated:parsed?.truncated ?? (parsed?.remainingCharacters>0) ?? false, response_time_ms:parsed?.responseTimeMs ?? '', rss_mb:res.rss_mb ?? '', cpu_total_s:res.cpu_total_s ?? '', process_count:res.process_count ?? '', error_message:isErr ? text.slice(0,300) : ''});
  if (!pass || rep === 1) rawEvidence.push({scenario, condition, rep, tool, args, pass, is_error:isErr, text:text.slice(0,2000)});
  return {pass, isErr, text, latency, parsed};
}

async function closeBrowser() {
  try { await client.callTool({name:'browser_close',arguments:{}}); } catch {}
  await sleep(100);
}

const tools = (await client.listTools()).tools.map(t=>t.name);
rawEvidence.push({tool_discovery:tools});
record({scenario_id:'F0_TOOL_DISCOVERY',category:'functional',condition:'mcp',repetition:1,success:tools.length===7 && ['browser_flow','browser_configure','browser_close','multi_search','fetch_api','parse_document','download_file'].every(x=>tools.includes(x)),is_error:false,expected_error:false,tool_calls:1,latency_ms:0,output_chars:JSON.stringify(tools).length,body_length:'',truncated:false,response_time_ms:'',rss_mb:'',cpu_total_s:'',process_count:'',error_message:''});
// Warm-up browser once; warm-up is not included in the measured dataset.
await callMeasured({scenario:'WARMUP',category:'pilot',rep:0,tool:'browser_flow',args:{url:ROOT+'/html/basic',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},check:t=>t.includes('BROWSER_MARKER_RAYHAN_2026')});
rows.pop();

for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'S2_BROWSER_SNAPSHOT',category:'performance',rep:i,tool:'browser_flow',args:{url:ROOT+'/html/basic',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},check:t=>t.includes('BROWSER_MARKER_RAYHAN_2026'),resource:true});
}
for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'S3_HTML_SLICING',category:'performance',rep:i,tool:'browser_flow',args:{url:ROOT+'/html/large',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'html',startIndex:0,endIndex:500}},check:t=>{const j=jsonMaybe(t);return j?.remainingCharacters>0 && j?.content?.includes('LARGE_HTML_MARKER');},resource:i<=10});
}
for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'S4_API_NORMAL',category:'performance',rep:i,tool:'fetch_api',args:{url:ROOT+'/api/json',method:'GET',limit:2000},check:t=>t.includes('API_MARKER_RAYHAN_2026'),resource:true});
}
for (let i=1;i<=30;i++) {
  const file=path.join(process.cwd(),'thesis_tests','downloads',`download_${i}.txt`);
  try{if(fs.existsSync(file))fs.unlinkSync(file);}catch{}
  await callMeasured({scenario:'S6_FILE_DOWNLOAD',category:'performance',rep:i,tool:'download_file',args:{url:ROOT+'/files/sample.txt',destinationFolder:'thesis_tests/downloads',filename:`download_${i}.txt`},check:()=>fs.existsSync(file),resource:i<=10});
}
for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'S7_PDF_PARSE',category:'performance',rep:i,tool:'parse_document',args:{url:ROOT+'/files/sample.pdf'},check:t=>t.includes('PDF_MARKER_RAYHAN_2026'),resource:true});
}
for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'S8_DOCX_PARSE',category:'performance',rep:i,tool:'parse_document',args:{url:ROOT+'/files/sample.docx'},check:t=>t.includes('DOCX_MARKER_RAYHAN_2026'),resource:true});
}
for (let i=1;i<=20;i++) {
  const t0=performance.now(); let pass=true;
  const set=await callMeasured({scenario:'S9_SESSION_SET_PART',category:'support',rep:i,tool:'browser_flow',args:{url:ROOT+'/session/set',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}},check:t=>t.includes('SESSION_SET')});
  await closeBrowser();
  const chk=await client.callTool({name:'browser_flow',arguments:{url:ROOT+'/session/check',waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}}});
  const tx=textOf(chk); pass=set.pass && !chk.isError && tx.includes('SESSION_MARKER_RAYHAN_2026') && tx.includes('LOCAL_MARKER_RAYHAN_2026');
  rows.pop();
  record({scenario_id:'S9_PERSISTENT_SESSION',category:'reliability',condition:'mcp',repetition:i,success:pass,is_error:!!chk.isError,expected_error:false,tool_calls:3,latency_ms:+(performance.now()-t0).toFixed(3),output_chars:tx.length,body_length:'',truncated:false,response_time_ms:'',...getResourceSnapshot(),error_message:pass?'':tx.slice(0,300)});
}
await closeBrowser();
for (let i=1;i<=20;i++) {
  const t0=performance.now(); let okay=true;
  for(let n=0;n<12;n++) {
    const r=await client.callTool({name:'browser_flow',arguments:{url:ROOT+`/html/basic?rep=${i}&tab=${n}`,newTab:true,waitForNetworkIdle:false,stabilizeMs:0,result:{type:'snapshot',mode:'tree'}}});
    if(r.isError || !textOf(r).includes('BROWSER_MARKER_RAYHAN_2026')) okay=false;
  }
  const list=await client.callTool({name:'browser_tabs',arguments:{action:'list'}}); const txt=textOf(list); let count=-1;
  try{count=JSON.parse(txt).length}catch{}
  okay = okay && !list.isError && count===10;
  record({scenario_id:'S10_TAB_LIFECYCLE',category:'reliability',condition:'mcp',repetition:i,success:okay,is_error:!!list.isError,expected_error:false,tool_calls:13,latency_ms:+(performance.now()-t0).toFixed(3),output_chars:txt.length,body_length:count,truncated:false,response_time_ms:'',...getResourceSnapshot(),error_message:okay?'':`tab_count=${count}`});
  await closeBrowser();
}
for (let i=1;i<=20;i++) {
  await callMeasured({scenario:'R1_FORCED_TIMEOUT',category:'reliability',rep:i,tool:'fetch_api',args:{url:ROOT+'/api/delay?ms=500',method:'GET',limit:2000,timeout:50},expectedError:true,check:t=>/timed out|timeout/i.test(t)});
}
for (let i=1;i<=20;i++) {
  await callMeasured({scenario:'R2_CONNECTION_REFUSED',category:'reliability',rep:i,tool:'fetch_api',args:{url:'http://127.0.0.1:65534/unavailable',method:'GET',limit:1000,timeout:300},expectedError:true,check:t=>isErrorText(t)});
}
for (let i=1;i<=20;i++) {
  await callMeasured({scenario:'R3_INVALID_DOCUMENT',category:'reliability',rep:i,tool:'parse_document',args:{url:ROOT+'/files/sample.txt'},expectedError:true,check:t=>/unsupported document type/i.test(t)});
}
for (let i=1;i<=20;i++) {
  await callMeasured({scenario:'R4_INVALID_TAB',category:'reliability',rep:i,tool:'browser_flow',args:{tabIndex:999,result:{type:'snapshot',mode:'tree'}},expectedError:true,check:t=>/invalid tabIndex/i.test(t)});
}
await closeBrowser();

// Output-control pairs: same endpoint, same payload, only output limit differs.
for (let i=1;i<=30;i++) {
  await callMeasured({scenario:'PAIR_OUTPUT',category:'process',condition:'baseline_full',rep:i,tool:'fetch_api',args:{url:ROOT+'/api/large',method:'GET',limit:20000},check:t=>{const j=jsonMaybe(t);return j?.ok===true && j?.truncated===false;},toolCalls:1});
  await callMeasured({scenario:'PAIR_OUTPUT',category:'process',condition:'mcp_limited',rep:i,tool:'fetch_api',args:{url:ROOT+'/api/large',method:'GET',limit:500},check:t=>{const j=jsonMaybe(t);return j?.ok===true && j?.truncated===true;},toolCalls:1});
}
async function runBrowserPair(condition, rep) {
  const t0=performance.now(); let calls=0, text='', isErr=false;
  try {
    if(condition==='baseline') {
      let r=await client.callTool({name:'browser_navigate',arguments:{url:ROOT+'/html/basic'}}); calls++; if(r.isError) throw new Error(textOf(r));
      r=await client.callTool({name:'browser_action',arguments:{action:'click',selector:'#btn'}}); calls++; if(r.isError) throw new Error(textOf(r));
      r=await client.callTool({name:'browser_snapshot',arguments:{mode:'tree'}}); calls++; text=textOf(r); isErr=!!r.isError;
    } else {
      const r=await client.callTool({name:'browser_flow',arguments:{url:ROOT+'/html/basic',actions:[{action:'click',selector:'#btn'}],result:{type:'snapshot',mode:'tree'}}}); calls++; text=textOf(r); isErr=!!r.isError;
    }
  } catch(e){isErr=true;text=String(e?.message||e)}
  const pass=!isErr && text.includes('clicked');
  record({scenario_id:'PAIR_BROWSER_ORCHESTRATION',category:'process',condition,repetition:rep,success:pass,is_error:isErr,expected_error:false,tool_calls:calls,latency_ms:+(performance.now()-t0).toFixed(3),output_chars:text.length,body_length:'',truncated:false,response_time_ms:'',...getResourceSnapshot(),error_message:pass?'':text.slice(0,300)});
}
await callMeasured({scenario:'PAIR_WARMUP',category:'pilot',rep:0,tool:'browser_flow',args:{url:ROOT+'/html/basic',result:{type:'snapshot',mode:'tree'}},check:t=>t.includes('BROWSER_MARKER_RAYHAN_2026')}); rows.pop();
for(let i=1;i<=30;i++) {
  if(i%2===1){await runBrowserPair('baseline',i); await runBrowserPair('mcp',i);} else {await runBrowserPair('mcp',i); await runBrowserPair('baseline',i);}
}
await closeBrowser();
const searchQueries=['Model Context Protocol','Puppeteer browser automation'];
async function runSearchPair(condition, rep) {
  const t0=performance.now(); let calls=0, text='', isErr=false, pass=false;
  try {
    if(condition==='baseline') {
      const parts=[];
      for(const q of searchQueries){const r=await client.callTool({name:'google_search',arguments:{query:q,num:3}}); calls++; if(r.isError) throw new Error(textOf(r)); parts.push(textOf(r));}
      text=parts.join('\n'); pass=parts.every(p=>{const j=jsonMaybe(p);return Array.isArray(j)&&j.length>0;});
    } else {
      const r=await client.callTool({name:'multi_search',arguments:{queries:searchQueries}}); calls++; text=textOf(r); if(r.isError) throw new Error(text); const j=jsonMaybe(text); pass=Array.isArray(j)&&j.length===2&&j.every(x=>Array.isArray(x.results)&&x.results.length>0);
    }
  } catch(e){isErr=true;text=String(e?.message||e);pass=false}
  record({scenario_id:'PAIR_SEARCH',category:'process',condition,repetition:rep,success:pass,is_error:isErr,expected_error:false,tool_calls:calls,latency_ms:+(performance.now()-t0).toFixed(3),output_chars:text.length,body_length:'',truncated:false,response_time_ms:'',rss_mb:'',cpu_total_s:'',process_count:'',error_message:pass?'':text.slice(0,300)});
}
for(let i=1;i<=10;i++) {
  if(i%2===1){await runSearchPair('baseline',i); await runSearchPair('mcp',i);} else {await runSearchPair('mcp',i); await runSearchPair('baseline',i);}
}
await closeBrowser();
const headers=['timestamp','scenario_id','category','condition','repetition','success','is_error','expected_error','tool_calls','latency_ms','output_chars','body_length','truncated','response_time_ms','rss_mb','cpu_total_s','process_count','error_message'];
const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;
const csv=[headers.join(','),...rows.map(r=>headers.map(h=>esc(r[h])).join(','))].join('\n');
fs.writeFileSync(path.join(OUT,'bab5_runs.csv'),csv,'utf8');
fs.writeFileSync(path.join(OUT,'bab5_evidence.json'),JSON.stringify(rawEvidence,null,2),'utf8');
const groups={};
for(const r of rows){const k=`${r.scenario_id}::${r.condition}`;(groups[k]??=[]).push(r);}
const summary={};
for(const [k,g] of Object.entries(groups)){
  const lat=g.map(x=>Number(x.latency_ms)).filter(Number.isFinite).sort((a,b)=>a-b); const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
  summary[k]={n:g.length,success:g.filter(x=>x.success).length,success_rate:+(100*g.filter(x=>x.success).length/g.length).toFixed(2),mean_latency_ms:+avg(lat).toFixed(3),median_latency_ms:+lat[Math.floor(lat.length/2)].toFixed(3),p95_latency_ms:+lat[Math.min(lat.length-1,Math.ceil(.95*lat.length)-1)].toFixed(3),mean_tool_calls:+avg(g.map(x=>Number(x.tool_calls))).toFixed(3),mean_output_chars:+avg(g.map(x=>Number(x.output_chars))).toFixed(2)};
}
fs.writeFileSync(path.join(OUT,'bab5_summary.json'),JSON.stringify(summary,null,2),'utf8');
console.log(`Completed ${rows.length} measured runs. Results: ${OUT}`);
await client.close();