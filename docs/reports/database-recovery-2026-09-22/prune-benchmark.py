import hashlib,json,os,pathlib,re,sqlite3,statistics,time
ART=pathlib.Path(__file__).resolve().parent;ROOT=pathlib.Path(os.environ.get('COGNIA_ROOT', pathlib.Path.cwd()))
OUTPUT=pathlib.Path(os.environ.get('COGNIA_PRUNE_OUTPUT', ART/'prune-benchmark.json'))
before=(ART/'session-store-before-retention.rs.txt').read_text();after=(ROOT/'crates/cognia-agent-state/src/agent_session_store/mod.rs').read_text()
def extract(source):
    section=source.split('pub fn prune(',1)[1].split('pub fn backup_to(',1)[0]
    result=re.findall(r'\.execute\(\s*"([^"]+)"',section,re.S)
    assert len(result)==2
    return result
queries={'baseline':extract(before),'current':extract(after)}
assert before.split('pub fn list_sessions(',1)[1].split('pub fn list_subkeys(',1)[0]==after.split('pub fn list_sessions(',1)[1].split('pub fn list_subkeys(',1)[0]
schema=re.search(r'const SCHEMA_SQL: &str = "(.*?)";',after,re.S).group(1);schema=re.sub(r'--[^\n]*','',schema)
report={'sqliteVersion':sqlite3.sqlite_version,'sql':queries,'method':'exact production SQL, in-memory SQLite, 1 warmup +10 paired AB/BA samples, rollback after each full prune transaction','fixtures':[]}
for n,sessions,summary_old in [(100000,100,False),(100000,1000,True),(100000,100000,False)]:
    conn=sqlite3.connect(':memory:');conn.executescript(schema)
    conn.executemany('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',(('t','w','p',f's{i%sessions:08d}','',i//sessions,f'u{i}','assistant','{}',1000000+i) for i in range(n)))
    conn.executemany('INSERT INTO summaries VALUES (?,?,?,?,?,?,?)',(('t','w','p',f's{i:08d}',0 if summary_old else 1000000,'{}',1) for i in range(sessions)));conn.commit()
    def run(name):
        conn.execute('BEGIN')
        try:
            for query in queries[name]:conn.execute(query,(100,))
        finally:conn.rollback()
    for name in queries:run(name)
    samples={name:[] for name in queries}
    for i in range(10):
        for name in (['baseline','current'] if i%2==0 else ['current','baseline']):
            start=time.perf_counter_ns();run(name);samples[name].append((time.perf_counter_ns()-start)/1e6)
    result={'entries':n,'sessions':sessions,'expiredSummaries':summary_old}
    for name,values in samples.items():
        median=statistics.median(values);result[name]={'medianMs':median,'madMs':statistics.median(abs(x-median) for x in values),'samplesMs':values}
    b=result['baseline']['medianMs'];a=result['current']['medianMs'];result['overheadPercent']=100*(a-b)/b;result['withinGuardrail']=a-b<=max(1,.2*b)
    report['fixtures'].append(result);print(json.dumps(result),flush=True)
    if not summary_old and sessions==100:
        report['plans']=[conn.execute('EXPLAIN QUERY PLAN '+query,(100,)).fetchall() for query in queries['current']]
    conn.close()
OUTPUT.write_text(json.dumps(report,indent=2)+'\n')
