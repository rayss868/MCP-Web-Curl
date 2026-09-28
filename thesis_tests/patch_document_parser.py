from pathlib import Path
p = Path(r'D:\All_project\own\AI_Coder\Native Tools\curl\src\index.ts')
s = p.read_text(encoding='utf-8')
s = s.replace("const pdf = require('pdf-parse');", "const { PDFParse } = require('pdf-parse');\nimport mammoth from 'mammoth';")
old = """        } else if (toolName === 'parse_document') {\n          const { url } = args as any;\n          const res = await fetch(url);\n          const data = await pdf(Buffer.from(await res.arrayBuffer()));\n          return { content: [{ type: 'text', text: data.text }] };\n"""
new = """        } else if (toolName === 'parse_document') {\n          const { url } = args as any;\n          const res = await fetch(url);\n          if (!res.ok) throw new Error(`Failed to fetch document: ${res.status} ${res.statusText}`);\n          const buffer = Buffer.from(await res.arrayBuffer());\n          const contentType = (res.headers.get('content-type') || '').toLowerCase();\n          const pathname = new URL(url).pathname.toLowerCase();\n\n          if (contentType.includes('pdf') || pathname.endsWith('.pdf')) {\n            const parser = new PDFParse({ data: buffer });\n            try {\n              const data = await parser.getText();\n              return { content: [{ type: 'text', text: data.text }] };\n            } finally {\n              await parser.destroy();\n            }\n          }\n\n          if (contentType.includes('wordprocessingml') || pathname.endsWith('.docx')) {\n            const data = await mammoth.extractRawText({ buffer });\n            return { content: [{ type: 'text', text: data.value }] };\n          }\n\n          throw new Error('Unsupported document type. Only PDF and DOCX are supported.');\n"""
if old not in s:
    raise SystemExit('parse_document block not found')
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')
print('patched', p)