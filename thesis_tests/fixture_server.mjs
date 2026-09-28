import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');
const PORT = Number(process.env.THESIS_FIXTURE_PORT || 8123);
const send = (res, code, type, body) => { res.writeHead(code, {'Content-Type': type}); res.end(body); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/api/json') return send(res, 200, 'application/json', JSON.stringify({ok:true, marker:'API_MARKER_RAYHAN_2026', value:42}));
  if (u.pathname === '/api/large') return send(res, 200, 'application/json', JSON.stringify({marker:'LARGE_API_MARKER', data:'X'.repeat(12000)}));
  if (u.pathname === '/api/delay') { const ms = Number(u.searchParams.get('ms') || 500); await new Promise(r => setTimeout(r, ms)); return send(res, 200, 'application/json', JSON.stringify({ok:true, delayed_ms:ms})); }
  if (u.pathname === '/html/basic') return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><head><title>Thesis Fixture</title></head><body><h1>BROWSER_MARKER_RAYHAN_2026</h1><p id="status">ready</p><a href="http://127.0.0.1:${PORT}/html/second">Second page</a><button id="btn" onclick="document.getElementById('status').textContent='clicked'">Click me</button><script>console.log('fixture-console-marker')</script></body></html>`);
  if (u.pathname === '/html/second') return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><html><body><h1>SECOND_PAGE_MARKER</h1></body></html>');
  if (u.pathname === '/html/large') return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><body><h1>LARGE_HTML_MARKER</h1><div>${'CONTENT '.repeat(5000)}</div></body></html>`);
  if (u.pathname === '/session/set') return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><body><script>document.cookie='thesis_session=SESSION_MARKER_RAYHAN_2026; path=/'; localStorage.setItem('thesis_local','LOCAL_MARKER_RAYHAN_2026');</script><h1>SESSION_SET</h1></body></html>`);
  if (u.pathname === '/session/check') return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><body><h1>SESSION_CHECK</h1><div id="cookie"></div><div id="local"></div><script>document.getElementById('cookie').textContent=document.cookie; document.getElementById('local').textContent=localStorage.getItem('thesis_local')||'';</script></body></html>`);
  if (u.pathname.startsWith('/files/')) { const file = path.join(fixtures, path.basename(u.pathname)); if (!fs.existsSync(file)) return send(res,404,'text/plain','not found'); const ext=path.extname(file).toLowerCase(); const ct=ext==='.pdf'?'application/pdf':ext==='.docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain'; res.writeHead(200, {'Content-Type':ct}); return fs.createReadStream(file).pipe(res); }
  return send(res, 404, 'text/plain', 'not found');
});
server.listen(PORT, '127.0.0.1', () => console.log(`fixture-server:${PORT}`));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));