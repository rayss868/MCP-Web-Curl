from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import textwrap, math

OUT=Path(r'D:\All_project\own\AI_Coder\Native Tools\curl\thesis_figures\bab4')
W,H=2200,1350
BG='#ffffff'; INK='#1f2937'; MUTED='#64748b'; TEAL='#0f766e'; TEAL2='#14b8a6'; BLUE='#2563eb'; SKY='#dbeafe'; GREEN='#16a34a'; MINT='#dcfce7'; GOLD='#d97706'; SAND='#fef3c7'; RED='#dc2626'; ROSE='#fee2e2'; PURPLE='#7c3aed'; LAV='#ede9fe'; LINE='#94a3b8'; PANEL='#f8fafc'
FONT=Path(r'C:\Windows\Fonts\segoeui.ttf'); FONTB=Path(r'C:\Windows\Fonts\segoeuib.ttf'); FONTS=Path(r'C:\Windows\Fonts\seguisb.ttf')

def font(sz,b=False,sb=False):
    p=FONTB if b else (FONTS if sb else FONT)
    return ImageFont.truetype(str(p),sz)

def rr(d,xy,fill='white',outline=LINE,r=24,w=3): d.rounded_rectangle(xy,radius=r,fill=fill,outline=outline,width=w)
def line(d,pts,fill=LINE,w=4): d.line(pts,fill=fill,width=w,joint='curve')
def arrow(d,a,b,fill=INK,w=5):
    line(d,[a,b],fill,w); ang=math.atan2(b[1]-a[1],b[0]-a[0]); L=18
    p1=(b[0]-L*math.cos(ang-.55),b[1]-L*math.sin(ang-.55)); p2=(b[0]-L*math.cos(ang+.55),b[1]-L*math.sin(ang+.55)); d.polygon([b,p1,p2],fill=fill)

def txt(d,xy,s,sz=34,fill=INK,b=False,sb=False,anchor='mm',maxw=None,spacing=8):
    f=font(sz,b,sb)
    if maxw:
        approx=max(8,int(maxw/(sz*.55))); s='\n'.join(textwrap.wrap(s,width=approx,break_long_words=False))
    d.multiline_text(xy,s,font=f,fill=fill,anchor=anchor,align='center',spacing=spacing)

def label(d,xy,s,fill=TEAL):
    x,y=xy; bb=d.textbbox((0,0),s,font=font(27,True)); ww=bb[2]-bb[0]+30; hh=bb[3]-bb[1]+18
    rr(d,(x-ww/2,y-hh/2,x+ww/2,y+hh/2),fill=fill,outline=fill,r=16,w=1); txt(d,(x,y),s,27,'white',b=True)

def canvas(): return Image.new('RGB',(W,H),BG), ImageDraw.Draw(Image.new('RGB',(1,1)))

def new():
    im=Image.new('RGB',(W,H),BG); return im,ImageDraw.Draw(im)

def save(im,name):
    im.save(OUT/name,optimize=True,dpi=(220,220))

# IV.1 context map: asymmetric ecosystem
im,d=new()
rr(d,(760,355,1440,995),fill='#f0fdfa',outline=TEAL,r=42,w=5)
label(d,(1100,425),'MCP-Web-Curl',TEAL)
txt(d,(1100,505),'Unified external-information gateway',33,MUTED,sb=True)
for i,(name,y,fc) in enumerate([('browser_flow',600,SKY),('fetch_api',700,SAND),('multi_search',800,MINT),('parse_document',900,LAV)]):
    rr(d,(890,y-36,1310,y+36),fill=fc,outline='#cbd5e1',r=18,w=2); txt(d,(1100,y),name,29,INK,sb=True)
rr(d,(120,430,580,740),fill='#eff6ff',outline=BLUE,r=36,w=4); label(d,(350,485),'Agentic Coding Assistant',BLUE); txt(d,(350,585),'MCP Host\n+ MCP Client',34,INK,sb=True); txt(d,(350,675),'tool discovery | tool call | result',25,MUTED)
arrow(d,(580,585),(760,585),TEAL,6); txt(d,(670,545),'MCP / stdio',25,MUTED)
for name,y,col in [('Web / Browser',300,SKY),('REST API',500,SAND),('Search Engine',700,MINT),('PDF / DOCX',900,LAV),('Files',1100,ROSE)]:
    rr(d,(1610,y-75,2070,y+75),fill=col,outline='#cbd5e1',r=30,w=3); txt(d,(1840,y),name,32,INK,sb=True)
    arrow(d,(1440,650 if name!='Files' else 850),(1610,y),TEAL,4)
rr(d,(760,1060,1440,1255),fill=PANEL,outline=LINE,r=32,w=3); label(d,(1100,1100),'Local Runtime State','#475569'); txt(d,(1100,1180),'persistent user_data | tabs | logs | screenshots',28,INK)
arrow(d,(1100,995),(1100,1060),MUTED,4)
save(im,'Gambar_IV_1_Context_Map.png')

# IV.2 layered architecture
im,d=new()
rr(d,(170,185,2030,1170),fill=PANEL,outline='#cbd5e1',r=42,w=4)
for y,h,fillc,title in [(230,160,'#ecfeff','MCP Interface Layer'),(430,245,'#eff6ff','Orchestration & Control Layer'),(720,260,'#f0fdf4','Capability Adapters'),(1015,110,'#fff7ed','Runtime Infrastructure')]:
    rr(d,(245,y,1955,y+h),fill=fillc,outline='#cbd5e1',r=28,w=2); label(d,(410,y+42),title,TEAL if y<720 else (GREEN if y<1000 else GOLD))
# interface
for x,s in [(760,'JSON-RPC / stdio'),(1120,'Tool Registry'),(1480,'Schema Validation')]: rr(d,(x-165,285,x+165,350),fill='white',outline=LINE,r=16,w=2); txt(d,(x,318),s,25,INK,sb=True)
# orchestration
for x,s in [(570,'Request Router'),(900,'Session Manager'),(1230,'Tab Manager'),(1560,'Output / Error Controller')]: rr(d,(x-145,515,x+145,600),fill='white',outline=LINE,r=18,w=2); txt(d,(x,558),s,25,INK,sb=True,maxw=255)
# adapters
for x,y,s in [(520,815,'browser_flow'),(880,815,'fetch_api'),(1240,815,'multi_search'),(1600,815,'parse_document'),(700,925,'download_file'),(1120,925,'browser_configure'),(1540,925,'browser_close')]: rr(d,(x-145,y-38,x+145,y+38),fill='white',outline=LINE,r=17,w=2); txt(d,(x,y),s,24,INK,sb=True)
for x,s in [(620,'Puppeteer / Chromium'),(1060,'Native Fetch + AbortController'),(1510,'File system + parsers')]: rr(d,(x-210,1045,x+210,1100),fill='white',outline=LINE,r=14,w=2); txt(d,(x,1072),s,22,INK,sb=True,maxw=390)
arrow(d,(1100,390),(1100,430),TEAL,5); arrow(d,(1100,675),(1100,720),TEAL,5); arrow(d,(1100,980),(1100,1015),TEAL,5)
save(im,'Gambar_IV_2_Layered_Architecture.png')

# IV.3 capability map: exposed tools vs supporting mechanisms
im,d=new()
rr(d,(120,170,2080,1180),fill='#fbfdff',outline='#cbd5e1',r=44,w=4)
label(d,(410,225),'Exposed Tool Surface',BLUE)
ex=[('browser_flow',330,340,SKY),('browser_configure',740,340,SKY),('browser_close',1150,340,SKY),('multi_search',1560,340,MINT),('fetch_api',535,510,SAND),('parse_document',1015,510,LAV),('download_file',1495,510,ROSE)]
for s,x,y,fc in ex:
    rr(d,(x-165,y-50,x+165,y+50),fill=fc,outline='#94a3b8',r=20,w=2); txt(d,(x,y),s,27,INK,sb=True)
label(d,(420,685),'Supporting Mechanisms',TEAL)
sp=[('Persistent Browser Profile',350,800),('10-Tab LRU Rotation',770,800),('Accessibility Snapshot',1190,800),('HTML Slicing',1610,800),('Network / Console Capture',560,990),('Timeout & Redirect Control',1050,990),('Cleanup & Idle Auto-Close',1540,990)]
for s,x,y in sp:
    rr(d,(x-180,y-48,x+180,y+48),fill='white',outline=TEAL,r=20,w=2); txt(d,(x,y),s,24,INK,sb=True,maxw=320)
# relationships
for x1,y1 in [(330,390),(740,390),(1150,390),(1560,390),(535,560),(1015,560),(1495,560)]: line(d,[(x1,y1),(x1,635),(1100,635)],'#cbd5e1',3)
for x2,y2 in [(350,752),(770,752),(1190,752),(1610,752),(560,942),(1050,942),(1540,942)]: line(d,[(1100,635),(1100,720),(x2,720),(x2,y2)],'#cbd5e1',3)
txt(d,(1840,1120),'Visible surface is intentionally smaller than internal capability set',24,MUTED,anchor='rm')
save(im,'Gambar_IV_3_Capability_Map.png')

# IV.4 dynamic browser_flow swimlane
im,d=new()
lanes=[('Host / Agent',180,510,'#eff6ff',BLUE),('MCP-Web-Curl',530,940,'#f0fdfa',TEAL),('Browser Runtime',960,1420,'#fff7ed',GOLD),('Target Website',1440,2030,'#f8fafc','#475569')]
for name,x1,x2,fc,oc in lanes:
    rr(d,(x1,120,x2,1210),fill=fc,outline=oc,r=24,w=2); label(d,((x1+x2)//2,170),name,oc)
steps=[(1,330,'tool.call(browser_flow)'),(2,455,'select/open tab'),(3,580,'navigate URL'),(4,705,'wait + stabilize'),(5,830,'actions: click/type/scroll'),(6,955,'collect snapshot/links/network'),(7,1080,'normalize result')]
for n,y,s in steps:
    d.ellipse((85,y-22,129,y+22),fill=TEAL); txt(d,(107,y),str(n),22,'white',b=True); txt(d,(155,y),s,24,INK,anchor='lm')
arrow(d,(510,330),(530,330),BLUE,4); arrow(d,(940,455),(960,455),TEAL,4); arrow(d,(1420,580),(1440,580),GOLD,4); arrow(d,(1440,705),(1420,705),GOLD,4); arrow(d,(940,830),(960,830),TEAL,4); arrow(d,(960,955),(940,955),TEAL,4); arrow(d,(530,1080),(510,1080),BLUE,4)
# optional loop and annotations
line(d,[(1200,455),(1320,455),(1320,830),(1200,830)],PURPLE,4); txt(d,(1260,650),'optional\naction loop',24,PURPLE,b=True)
rr(d,(620,1030,850,1135),fill='white',outline=TEAL,r=18,w=2); txt(d,(735,1082),'tree / html slice\nscreenshot / links\nnetwork / console',21,INK)
save(im,'Gambar_IV_4_BrowserFlow_Dynamic.png')

# IV.5 session + tab lifecycle: circular state machine
im,d=new()
center=(1100,690); rad=390
states=[('NEW',-150,SKY,BLUE),('OPEN',-90,SKY,BLUE),('ACTIVE',-25,MINT,GREEN),('IDLE',45,SAND,GOLD),('CLOSED',120,ROSE,RED)]
pts=[]
for name,deg,fc,oc in states:
    a=math.radians(deg); x=center[0]+rad*math.cos(a); y=center[1]+rad*.72*math.sin(a); pts.append((x,y,name,fc,oc))
for x,y,name,fc,oc in pts:
    d.ellipse((x-105,y-60,x+105,y+60),fill=fc,outline=oc,width=4); txt(d,(x,y),name,29,INK,b=True)
for i in range(len(pts)-1): arrow(d,(pts[i][0]+105,pts[i][1]),(pts[i+1][0]-105,pts[i+1][1]),TEAL,4)
# reopen loop
arrow(d,(pts[-1][0]-25,pts[-1][1]+60),(pts[1][0]-45,pts[1][1]+70),PURPLE,4)
txt(d,(520,1130),'reopen / create new tab',23,PURPLE,sb=True)
rr(d,(770,500,1430,875),fill='#f8fafc',outline='#cbd5e1',r=34,w=3); label(d,(1100,545),'Persistent Browser Profile','#475569'); txt(d,(1100,660),'cookies | cache | login state\nuser_data/ reused across requests',30,INK,sb=True); txt(d,(1100,800),'MAX_TABS = 10\noldest tab rotated when limit is reached',28,MUTED)
# idle timer orbit
line(d,[(470,260),(1730,260)],'#cbd5e1',3); txt(d,(1100,220),'15-minute idle auto-close',28,MUTED,sb=True)
arrow(d,(1730,260),(pts[-1][0],pts[-1][1]-65),RED,4)
save(im,'Gambar_IV_5_Session_Tab_StateMachine.png')

# IV.6 deployment topology
im,d=new()
# machine boundary
rr(d,(110,180,2090,1180),fill='#fbfdff',outline='#94a3b8',r=42,w=4)
label(d,(360,225),'Developer Workstation','#475569')
rr(d,(220,310,690,630),fill='#eff6ff',outline=BLUE,r=32,w=3); label(d,(455,355),'Agentic Coding Assistant',BLUE); txt(d,(455,455),'MCP Host + Client',33,INK,sb=True); txt(d,(455,545),'tool discovery\nJSON-RPC over stdio',25,MUTED)
rr(d,(805,275,1450,740),fill='#f0fdfa',outline=TEAL,r=34,w=4); label(d,(1125,325),'Node.js Runtime',TEAL); txt(d,(1125,420),'MCP-Web-Curl Server',38,INK,b=True); txt(d,(1125,515),'request routing | REST client\nsearch | document/file handlers',27,INK); rr(d,(925,610,1325,685),fill='white',outline=LINE,r=16,w=2); txt(d,(1125,648),'logs | screenshots | metrics',24,MUTED,sb=True)
rr(d,(805,815,1450,1080),fill='#fff7ed',outline=GOLD,r=30,w=3); label(d,(1125,860),'Chromium / Puppeteer',GOLD); txt(d,(1125,950),'persistent user_data/\nactive pages + tab state',28,INK,sb=True)
rr(d,(1590,300,1995,1040),fill='#f8fafc',outline='#475569',r=30,w=3); label(d,(1792,350),'External Services','#475569');
for s,y in [('Websites',455),('REST APIs',575),('Google Custom Search',695),('PDF / DOCX URLs',815),('Download Targets',935)]: rr(d,(1645,y-35,1940,y+35),fill='white',outline='#cbd5e1',r=14,w=2); txt(d,(1792,y),s,23,INK,sb=True,maxw=270)
arrow(d,(690,470),(805,470),TEAL,5); txt(d,(748,430),'stdio',23,MUTED)
arrow(d,(1125,740),(1125,815),GOLD,5); txt(d,(1195,780),'browser process',22,MUTED,anchor='lm')
for y in [455,575,695,815,935]: arrow(d,(1450,520),(1590,y),TEAL,3)
txt(d,(1530,505),'HTTP/HTTPS',23,MUTED,anchor='mm')
save(im,'Gambar_IV_6_Deployment_Topology.png')

print('Generated:', *sorted(p.name for p in OUT.glob('Gambar_IV_*.png')), sep='\n- ')



# redraw IV.5 with cleaner lifecycle topology
im,d=new()
# main lifecycle row
xs=[360,720,1080,1440,1800]; names=['NEW','OPEN','ACTIVE','IDLE','CLOSED']; fills=[SKY,SKY,MINT,SAND,ROSE]; outs=[BLUE,BLUE,GREEN,GOLD,RED]
for x,n,fc,oc in zip(xs,names,fills,outs):
    d.ellipse((x-105,300,x+105,410),fill=fc,outline=oc,width=4); txt(d,(x,355),n,28,INK,b=True)
for a,b in zip(xs[:-1],xs[1:]): arrow(d,(a+105,355),(b-105,355),TEAL,5)
txt(d,(540,285),'create page',22,MUTED); txt(d,(900,285),'select/use',22,MUTED); txt(d,(1260,285),'inactive',22,MUTED); txt(d,(1620,285),'close / idle timeout',22,MUTED)
# reopen path
line(d,[(1800,410),(1800,510),(720,510),(720,410)],PURPLE,4); arrow(d,(720,510),(720,410),PURPLE,4); txt(d,(1260,545),'reopen flow creates or reselects a usable tab',23,PURPLE,sb=True)
# persistent profile foundation
rr(d,(330,700,1510,1110),fill='#f8fafc',outline='#94a3b8',r=36,w=3); label(d,(600,755),'Persistent Browser Profile','#475569'); txt(d,(920,850),'user_data/ keeps login state, cookies, and cache across tool calls',28,INK,sb=True,maxw=980); txt(d,(920,955),'Session continuity is independent from individual tab lifecycle',26,MUTED)
# LRU manager on right
rr(d,(1600,700,2040,1110),fill='#f0fdfa',outline=TEAL,r=36,w=3); label(d,(1820,755),'Tab Manager',TEAL); txt(d,(1820,850),'MAX_TABS = 10',31,INK,b=True); txt(d,(1820,930),'oldest tab is rotated\nwhen the limit is reached',25,MUTED); txt(d,(1820,1030),'15-minute browser\nidle auto-close',24,RED,sb=True)
arrow(d,(1440,410),(1820,700),TEAL,4); arrow(d,(1820,700),(1800,410),RED,3)
save(im,'Gambar_IV_5_Session_Tab_StateMachine.png')
