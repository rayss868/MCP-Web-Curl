from pathlib import Path
import json, math
import numpy as np
import pandas as pd
from scipy import stats
import matplotlib.pyplot as plt

ROOT = Path(r'D:\All_project\own\AI_Coder\Native Tools\curl\thesis_tests\results')
FIG = ROOT / 'figures'
FIG.mkdir(parents=True, exist_ok=True)
df = pd.read_csv(ROOT / 'bab5_runs.csv')
res = pd.DataFrame(json.loads((ROOT / 'resource_benchmark.json').read_text(encoding='utf-8')))

def p95(x): return np.percentile(np.asarray(x,float),95)
def desc(group):
    x=group['latency_ms'].astype(float)
    return pd.Series({'n':len(group),'success_n':int(group['success'].sum()),'success_rate_pct':100*group['success'].mean(),'mean_ms':x.mean(),'median_ms':x.median(),'std_ms':x.std(ddof=1),'min_ms':x.min(),'p95_ms':p95(x),'max_ms':x.max()})

perf_ids=['S2_BROWSER_SNAPSHOT','S3_HTML_SLICING','S4_API_NORMAL','S6_FILE_DOWNLOAD','S7_PDF_PARSE','S8_DOCX_PARSE','S9_PERSISTENT_SESSION','S10_TAB_LIFECYCLE']
perf=df[df.scenario_id.isin(perf_ids)].groupby('scenario_id',sort=False).apply(desc,include_groups=False).reset_index()
perf.to_csv(ROOT/'table_performance.csv',index=False)
rel_ids=['R1_FORCED_TIMEOUT','R2_CONNECTION_REFUSED','R3_INVALID_DOCUMENT','R4_INVALID_TAB','S9_PERSISTENT_SESSION','S10_TAB_LIFECYCLE']
rel=df[df.scenario_id.isin(rel_ids)].groupby('scenario_id',sort=False).agg(n=('success','size'),pass_n=('success','sum'),pass_rate_pct=('success',lambda x:100*x.mean()),median_ms=('latency_ms','median'),p95_ms=('latency_ms',p95)).reset_index()
rel.to_csv(ROOT/'table_reliability.csv',index=False)

def rank_biserial(diff):
    d=np.asarray(diff,float); d=d[d!=0]
    if len(d)==0:return 0.0
    ranks=stats.rankdata(abs(d)); pos=ranks[d>0].sum(); neg=ranks[d<0].sum()
    return (pos-neg)/(pos+neg)

def bootstrap_ci(diff, nboot=10000, seed=2026):
    d=np.asarray(diff,float); rng=np.random.default_rng(seed)
    means=np.array([rng.choice(d,size=len(d),replace=True).mean() for _ in range(nboot)])
    return np.percentile(means,[2.5,97.5])

def paired_result(scenario,a,b,metric='latency_ms'):
    x=df[(df.scenario_id==scenario)&(df.condition==a)][['repetition',metric,'success']].rename(columns={metric:'a','success':'sa'})
    y=df[(df.scenario_id==scenario)&(df.condition==b)][['repetition',metric,'success']].rename(columns={metric:'b','success':'sb'})
    m=x.merge(y,on='repetition').dropna(); d=m.a.astype(float)-m.b.astype(float)
    sh=stats.shapiro(d) if len(d)>=3 else None
    if sh and sh.pvalue>=0.05:
        tst=stats.ttest_rel(m.a,m.b); method='paired t-test'; effect=d.mean()/d.std(ddof=1) if d.std(ddof=1)>0 else np.nan
    else:
        try:tst=stats.wilcoxon(m.a,m.b,zero_method='wilcox'); effect=rank_biserial(d)
        except ValueError:tst=type('X',(object,),{'statistic':0.0,'pvalue':1.0})(); effect=0.0
        method='Wilcoxon signed-rank'
    ci=bootstrap_ci(d)
    return {'scenario':scenario,'metric':metric,'condition_a':a,'condition_b':b,'n':len(m),'mean_a':m.a.mean(),'mean_b':m.b.mean(),'median_a':m.a.median(),'median_b':m.b.median(),'mean_difference_a_minus_b':d.mean(),'median_difference':d.median(),'shapiro_W':sh.statistic if sh else np.nan,'shapiro_p':sh.pvalue if sh else np.nan,'test':method,'statistic':float(tst.statistic),'p_value':float(tst.pvalue),'effect_size':float(effect) if np.isfinite(effect) else np.nan,'ci95_low':float(ci[0]),'ci95_high':float(ci[1]),'success_a_pct':100*m.sa.mean(),'success_b_pct':100*m.sb.mean()}

stats_rows=[paired_result('PAIR_BROWSER_ORCHESTRATION','baseline','mcp','latency_ms'),paired_result('PAIR_SEARCH','baseline','mcp','latency_ms'),paired_result('PAIR_OUTPUT','baseline_full','mcp_limited','output_chars')]
pd.DataFrame(stats_rows).to_csv(ROOT/'table_statistical_tests.csv',index=False)
(ROOT/'statistical_tests.json').write_text(json.dumps(stats_rows,indent=2),encoding='utf-8')

# Figure V.1: latency distribution for core local operations.
labels_map={'S2_BROWSER_SNAPSHOT':'Browser snapshot','S3_HTML_SLICING':'HTML slicing','S4_API_NORMAL':'REST API','S6_FILE_DOWNLOAD':'File download','S7_PDF_PARSE':'PDF parse','S8_DOCX_PARSE':'DOCX parse'}
ids=list(labels_map)
vals=[df[df.scenario_id==s].latency_ms.astype(float).values for s in ids]
plt.figure(figsize=(9,5.2)); plt.boxplot(vals,tick_labels=[labels_map[s] for s in ids],showfliers=True); plt.ylabel('Latency (ms)'); plt.xticks(rotation=20,ha='right'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_1_Latency_Boxplot.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.2: batch throughput.
rlabels={'API_LOCAL':'REST API','PDF_PARSE_LOCAL':'PDF parse','DOCX_PARSE_LOCAL':'DOCX parse','FILE_DOWNLOAD_LOCAL':'File download','BROWSER_SNAPSHOT_WARM':'Browser snapshot'}
r=res[res.scenario.isin(rlabels)].copy();
plt.figure(figsize=(8.5,4.8)); plt.bar([rlabels[x] for x in r.scenario],r.ops_per_s); plt.ylabel('Operasi berhasil per detik'); plt.xticks(rotation=18,ha='right'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_2_Throughput.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.3: normalized CPU utilization during batch execution.
plt.figure(figsize=(8.5,4.8)); plt.bar([rlabels[x] for x in r.scenario],r.cpu_util_pct); plt.ylabel('Utilisasi CPU ternormalisasi (%)'); plt.xticks(rotation=18,ha='right'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_3_CPU_Utilization.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.4: ending working-set memory.
plt.figure(figsize=(8.5,4.8)); plt.bar([rlabels[x] for x in r.scenario],r.rss_after_mb); plt.ylabel('Working-set memory (MB)'); plt.xticks(rotation=18,ha='right'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_4_Memory_Utilization.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.5: output size, full versus limited.
o=df[df.scenario_id=='PAIR_OUTPUT']
base=o[o.condition=='baseline_full'].output_chars.astype(float); lim=o[o.condition=='mcp_limited'].output_chars.astype(float)
plt.figure(figsize=(6.8,4.8)); plt.boxplot([base,lim],tick_labels=['Full output','Output dibatasi']); plt.ylabel('Ukuran respons yang dikembalikan (karakter)'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_5_Output_Size.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.6: mean tool-call comparison.
pairs=[]
for scen,label in [('PAIR_BROWSER_ORCHESTRATION','Browser workflow'),('PAIR_SEARCH','Pencarian')]:
    g=df[df.scenario_id==scen].groupby('condition').tool_calls.mean(); pairs.append((label,g.get('baseline',np.nan),g.get('mcp',np.nan)))
x=np.arange(len(pairs)); w=.34
plt.figure(figsize=(7.2,4.8)); plt.bar(x-w/2,[p[1] for p in pairs],w,label='Baseline'); plt.bar(x+w/2,[p[2] for p in pairs],w,label='MCP-Web-Curl'); plt.ylabel('Rata-rata jumlah tool call'); plt.xticks(x,[p[0] for p in pairs]); plt.legend(); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_6_Tool_Call_Comparison.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.7: mean completion time comparison.
ct=[]
for scen,label in [('PAIR_BROWSER_ORCHESTRATION','Browser workflow'),('PAIR_SEARCH','Pencarian')]:
    g=df[df.scenario_id==scen].groupby('condition').latency_ms.mean()/1000; ct.append((label,g.get('baseline',np.nan),g.get('mcp',np.nan)))
plt.figure(figsize=(7.2,4.8)); plt.bar(x-w/2,[p[1] for p in ct],w,label='Baseline'); plt.bar(x+w/2,[p[2] for p in ct],w,label='MCP-Web-Curl'); plt.ylabel('Completion time rata-rata (s)'); plt.xticks(x,[p[0] for p in ct]); plt.legend(); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_7_Completion_Time.png',dpi=240,bbox_inches='tight'); plt.close()

# Figure V.8: reliability pass rate.
rr=rel.copy(); names={'R1_FORCED_TIMEOUT':'Forced timeout','R2_CONNECTION_REFUSED':'Connection refused','R3_INVALID_DOCUMENT':'Invalid document','R4_INVALID_TAB':'Invalid tab','S9_PERSISTENT_SESSION':'Persistent session','S10_TAB_LIFECYCLE':'Tab lifecycle'}
plt.figure(figsize=(9,4.8)); plt.bar([names[x] for x in rr.scenario_id],rr.pass_rate_pct); plt.ylim(0,105); plt.ylabel('Pass rate (%)'); plt.xticks(rotation=18,ha='right'); plt.grid(axis='y',alpha=.25); plt.tight_layout(); plt.savefig(FIG/'Gambar_V_8_Reliability_Success.png',dpi=240,bbox_inches='tight'); plt.close()

print('Performance table:\n',perf.round(3).to_string(index=False)); print('\nReliability table:\n',rel.round(3).to_string(index=False)); print('\nStatistical tests:\n',pd.DataFrame(stats_rows).round(5).to_string(index=False)); print('\nResource benchmark:\n',res.round(3).to_string(index=False))
