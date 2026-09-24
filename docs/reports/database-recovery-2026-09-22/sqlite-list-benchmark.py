import hashlib, json, pathlib, re, sqlite3, statistics, time
ROOT=pathlib.Path.cwd()
ART=pathlib.Path(__file__).resolve().parent
source=(ART/'session-store-before.rs.txt').read_text()
schema=re.search(r'const SCHEMA_SQL: &str = "(.*?)";',source,re.S).group(1)
schema=re.sub(r'--[^\n]*','',schema)
baseline=re.search(r'pub fn list_sessions\(.*?\.prepare\(\s*"(.*?)"',source,re.S).group(1)
candidate="""WITH RECURSIVE session_ids(session_id) AS (
    SELECT MIN(session_id) FROM entries
    WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
    UNION ALL
    SELECT (SELECT MIN(session_id) FROM entries
            WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
              AND session_id > session_ids.session_id)
    FROM session_ids WHERE session_id IS NOT NULL
)
SELECT session_id, (SELECT written_at FROM entries
                   WHERE tenant = ?1 AND workspace = ?2 AND project_key = ?3
                     AND session_id = session_ids.session_id
                   ORDER BY written_at DESC LIMIT 1) AS mtime
FROM session_ids WHERE session_id IS NOT NULL ORDER BY mtime DESC"""
(ART/'sqlite-list-baseline.sql').write_text(baseline)
(ART/'sqlite-list-candidate.sql').write_text(candidate)

def measure(conn,query):
    conn.execute(query,('t','w','p')).fetchall()
    result=[]
    for _ in range(10):
        start=time.perf_counter_ns();conn.execute(query,('t','w','p')).fetchall();result.append((time.perf_counter_ns()-start)/1e6)
    median=statistics.median(result)
    return {'median_ms':median,'mad_ms':statistics.median(abs(x-median) for x in result),'samples_ms':result}

report={'sqlite_version':sqlite3.sqlite_version,'baseline_sha256':hashlib.sha256(baseline.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'fixtures':[]}
for n,sessions in [(100000,100),(100000,1000),(10000,10000),(100000,100000)]:
    conn=sqlite3.connect(':memory:');conn.executescript(schema)
    conn.executemany('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',(('t','w','p',f's{i%sessions:08d}','subagents/worker' if i%3==0 else '',i//sessions,f'u{i}','assistant','{}',1000000+i) for i in range(n)))
    conn.executemany('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',[(scope,workspace,project,'isolated','',0,'isolated-uuid','user','{}',999999999) for scope,workspace,project in [('other','w','p'),('t','other','p'),('t','w','other')]])
    conn.commit()
    expected=conn.execute(baseline,('t','w','p')).fetchall(); actual=conn.execute(candidate,('t','w','p')).fetchall();assert actual==expected
    before=measure(conn,baseline);after=measure(conn,candidate)
    item={'entries':n,'sessions':sessions,'equality':True,'baseline':before,'candidate':after,'improvement_percent':100*(before['median_ms']-after['median_ms'])/before['median_ms'],'greater_than_2_max_mad':before['median_ms']-after['median_ms']>2*max(before['mad_ms'],after['mad_ms'])}
    report['fixtures'].append(item);print(json.dumps(item),flush=True)
    if n==100000 and sessions==100:report['query_plan']=conn.execute('EXPLAIN QUERY PLAN '+candidate,('t','w','p')).fetchall()
    conn.close()
(ART/'sqlite-list-benchmark.json').write_text(json.dumps(report,indent=2)+'\n')
