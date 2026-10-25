# Fold results/<engine>.json into the matrix the research doc quotes.
# Run: python3 summarize.py chromium webkit
import json,sys
def short(lst):
    return ",".join(sorted(set(x.split()[0] for x in lst))) if lst else "-"
for eng in sys.argv[1:]:
    d=json.load(open(f'results/{eng}.json'))
    print(f'## {eng} {d.get("version")}')
    rows={}
    for r in d['results']:
        rows.setdefault(r['id'],{})[r['mode']]=r
    print("id | truth | classify | route | early | early-main | late | hold-ms")
    for id,m in rows.items():
        t=m.get('truth',{})
        truth=" ".join(sorted(set(f"{x.split()[1]} {x.split()[2]}" for x in t.get('truth',[])))) or "none"
        cl=t.get('classified',{}).get('submit','') if 'classified' in t else ''
        route=m.get('route',{}).get('seen')
        rs = "-" if route is None else (" ".join(sorted(set(("H" if x.startswith("HELD") else "s")+":"+x.split()[1]+(":"+x.split()[2] if len(x.split())>2 else "") for x in route))) or "none")
        def ic(mode):
            r=m.get(mode)
            if r is None: return "-"
            k=sorted(set(x.split()[0] for x in r.get('intercepted',[])))
            return ",".join(k) or "NONE"
        hold=m.get('inject-hold',{}).get('firstArrivalMs','-')
        ra=m.get('route-abort')
        extra=f" | abort→{ra.get('pageUrl')} truth={ra.get('truth')}" if ra else ""
        print(f"{id} | {truth} | {cl} | {rs} | {ic('inject-early')} | {ic('inject-early-main')} | {ic('inject-late')} | {hold}{extra}")
