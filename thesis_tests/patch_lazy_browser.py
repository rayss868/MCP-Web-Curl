from pathlib import Path
p=Path(r'D:\All_project\own\AI_Coder\Native Tools\curl\src\index.ts')
s=p.read_text(encoding='utf-8')
old="""        const page = await this.getPage();\n        if (toolName === 'browser_navigate') {\n"""
new="""        // Only browser-specific low-level tools need an active Page.\n        // Non-browser tools (API, search, document, download) must not launch Chromium.\n        // browser_flow and batch_navigate manage their own page lifecycle internally.\n        const pageTools = new Set([\n          'browser_navigate', 'browser_snapshot', 'browser_action', 'take_screenshot',\n          'browser_network_requests', 'browser_console_messages', 'browser_links'\n        ]);\n        const page: Page = pageTools.has(toolName) ? await this.getPage() : (null as any);\n        if (toolName === 'browser_navigate') {\n"""
if old not in s: raise SystemExit('target block not found')
p.write_text(s.replace(old,new),encoding='utf-8')
print('patched lazy browser initialization')