from pathlib import Path
p=Path(r'D:\All_project\own\AI_Coder\Native Tools\curl\src\index.ts')
s=p.read_text(encoding='utf-8')
old="""              body: { type: 'string', description: 'Optional request body.' },\n              limit: { type: 'number', description: 'Maximum number of characters to return from the response body.' }\n"""
new="""              body: { type: 'string', description: 'Optional request body.' },\n              timeout: { type: 'number', description: 'Request timeout in milliseconds (default 60000).' },\n              redirect: { type: 'string', enum: ['follow', 'error', 'manual'], description: 'Redirect handling mode (default follow).' },\n              limit: { type: 'number', description: 'Maximum number of characters to return from the response body.' }\n"""
if old not in s: raise SystemExit('fetch_api schema block not found')
p.write_text(s.replace(old,new),encoding='utf-8')
print('patched fetch_api schema')