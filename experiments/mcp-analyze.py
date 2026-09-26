# Summarize a LiveMCPBench experiment file: the first post's three scoring rules, cost, latency,
# and paired bootstrap differences against a baseline arm.
#   python3 experiments/mcp-analyze.py results/exp-mcp-staged.jsonl jev-search
import json, random, collections, statistics as st, sys
path, base = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(path)]
by = collections.defaultdict(dict)
for r in rows: by[r['strategyId']][r['queryId']] = r
server = lambda t: t.split('__')[0]
def score(r):
    rk, rel = r['ranking'], r['relevant']
    return (int(bool(rk) and rk[0] in rel), int(bool(rk) and server(rk[0]) in {server(x) for x in rel}), int(any(x in rel for x in rk[:5])))
qs = sorted(by[base])
pct = lambda v: f"{100 * sum(v) / len(v):.1f}%"
q95 = lambda v: sorted(v)[min(len(v) - 1, int(.95 * len(v)))]
for s, d in by.items():
    ms = [score(d[q]) for q in qs]; lat = [d[q]['latencyMs'] for q in qs]
    toks = [sum(c['inputTokens'] for c in d[q]['calls']) for q in qs]; reqs = [len(d[q]['calls']) for q in qs]
    plans = collections.Counter((d[q].get('extra') or {}).get('plan') for q in qs)
    err = sum(1 for q in qs if d[q].get('error'))
    print(f"{s:24} exact {pct([m[0] for m in ms])}  server {pct([m[1] for m in ms])}  top5 {pct([m[2] for m in ms])} | errors {err} | p50 {st.median(lat)/1000:.1f}s p95 {q95(lat)/1000:.1f}s | req {st.mean(reqs):.1f} tok {st.mean(toks)/1000:.1f}k ${st.mean(toks)*0.042/1000:.2f}/1k | {dict(plans)}")
def boot(a, b):
    d = [a[q] - b[q] for q in qs]; random.seed(42)
    m = sorted(sum(random.choice(d) for _ in d) / len(d) for _ in range(2000))
    return f"{100*sum(d)/len(d):+.1f} [{100*m[50]:.1f}, {100*m[1949]:.1f}]"
for k, name in enumerate(["exact", "server", "top5"]):
    H = {s: {q: score(d[q])[k] for q in qs} for s, d in by.items()}
    print(name, "; ".join(f"{s} vs {base}: {boot(H[s], H[base])}" for s in by if s != base))
