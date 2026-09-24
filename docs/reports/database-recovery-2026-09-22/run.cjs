/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS harness */
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const crypto = require("node:crypto")
const { createRequire } = require("node:module")
const root = process.env.COGNIA_ROOT || process.cwd()
const req = createRequire(path.join(root, "package.json"))
const esbuild = req("esbuild")
const { chromium } = req("@playwright/test")
const dir = __dirname
const variant = process.argv[2] || "baseline"
const resultSuffix = process.argv.includes("--archive-smoke") ? ".archive-smoke" : ""
const archiveRoot = path.join(dir, "baseline")
const source = variant === "baseline" ? archiveRoot : root
const messagePath = path.join(source, "lib/db/messages.ts")
const coalescerPath = path.join(source, "hooks/chat/stream-coalescing.ts")
const capturedMessages = fs.readFileSync(
  messagePath + (variant === "baseline" ? ".txt" : ""),
  "utf8"
)
const capturedCoalescer = fs.readFileSync(
  coalescerPath + (variant === "baseline" ? ".txt" : ""),
  "utf8"
)
const stub = {
  "@/lib/chat/search/indexer":
    "export const markSessionDirty=()=>{}; export const markMessagesRemoved=()=>{};",
  "@/lib/memory/lifecycle/claim-deletion-closure":
    "export const revokeClaimsForDeletedMessages=async()=>{}; export const revokeClaimsForDeletedSession=async()=>{}; export const revokeClaimsForChangedAttachment=async()=>{};",
  "@/lib/chat/transcript/revision-events": "export const publishTranscriptRevision=async()=>{};",
  "@/lib/workflow/runtime/trigger-subscriptions": "export const findMatchingWorkflows=()=>[];",
  "@/lib/workflow/runtime/trigger-bridge": "export const dispatchTrigger=async()=>{};",
  "@/lib/chat/trigger-audit-ring": "export const recordTriggerAuditEntry=()=>{};",
  "@cognia/agent-config-types":
    'export const applyReactionChange=()=>{throw new Error("unused reaction path")};',
  "@cognia/rag/hybrid-search": "export class BM25Index{}",
  "@cognia/rag/context-manager":
    'export const createContextManager=()=>{throw new Error("unused search path")};',
  "@cognia/rag/cjk-tokenizer":
    'export const tokenizeMultilingual=()=>{throw new Error("unused search path")};',
  "@/lib/ocr/hash":
    'export const sha256Blob=()=>{throw new Error("unsupported original blob path")};',
  "@/lib/ocr/image-prep":
    'export const bytesToBase64=()=>{throw new Error("unsupported materialization path")};',
}
const schema = `import Dexie from 'dexie';
import {createMessageSyncRevisionMiddleware} from '${path.join(dir, "baseline/lib/db/message-sync-revision.ts")}';
export const db = new Dexie('cognia-isolated-performance');
db.version(1).stores({
 sessions:'id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt], [projectId+createdAt+id], surfaceBindingKey, squadId',
 messages:'id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt], turnKey, [sessionId+turnKey], [syncRevision+id]',
 messageSyncClock:'id',
 messageMediaRefs:'[messageId+hash], sessionId, messageId, hash, [sessionId+hash]',
 messageMedia:'hash,createdAt',
});
db.use(createMessageSyncRevisionMiddleware());
export const getDb=()=>db;
export const withDbReopenRetry=async(work)=>{try{return await work()}catch(e){if(e?.name==='DatabaseClosedError'){await db.open();return work()}throw e}};
window.benchmarkDb=db;`
const entry = `import {SessionCoalescingRegistry} from '${path.join(source, "hooks/chat/stream-coalescing.ts")}';
import {persistMessages,persistStreamingMessages,listMessages,listRecentMessages,invalidatePersistSnapshot} from '${path.join(source, "lib/db/messages.ts")}';
import {getDb} from 'benchmark-schema';
const db=getDb();
let messages=[];
const sid='bench-session';
const check=(ok,label)=>{if(!ok)throw Error(label)};
window.bench={
 async setup(count,attachments){
  invalidatePersistSnapshot(sid);
  await db.delete(); await db.open();
  await db.sessions.put({id:sid,projectId:'bench-project',createdAt:1,updatedAt:1});
  messages=Array.from({length:count},(_,i)=>({id:'msg-'+String(i).padStart(8,'0'),role:i%2?'assistant':'user',parts:[{type:'text',text:String(i).padStart(8,'0')+'x'.repeat(2040)},...(attachments?[{type:'file',url:'cognia-media:existing-'+(i%16),mediaType:'image/png',filename:'image-'+i+'.png',width:128,height:128,byteSize:1024}]:[])],metadata:{triggerWorkflows:false}}));
  const start=performance.now();await persistMessages(sid,messages);const seedMs=performance.now()-start;
  return {seedMs,count:await db.messages.count(),refs:await db.messageMediaRefs.count()};
 },
 async run(kind,index){
  if(kind==='full-change'||kind==='streaming'){
   const old=messages.at(-1);messages[messages.length-1]={...old,parts:[{type:'text',text:String(index).padStart(8,'0')+'x'.repeat(2040)},...old.parts.slice(1)]};
  }
  const start=performance.now();
  if(kind==='streaming')await persistStreamingMessages(sid,messages);
  else if(kind==='restore-all')await listMessages(sid);
  else if(kind==='restore-recent')await listRecentMessages(sid,80);
  else await persistMessages(sid,messages);
  return performance.now()-start;
 },
 async verify(count,attachments){
  check(await db.messages.count()===count,'row count');
  check(await db.messageMediaRefs.count()===(attachments?count:0),'media ref count');
  const rows=await listMessages(sid);check(rows.length===count,'restore row count');
  check(rows[0].parts[0].text===messages[0].parts[0].text,'first content');
  check(rows.at(-1).parts[0].text===messages.at(-1).parts[0].text,'last content');
  const recent=await listRecentMessages(sid,80);check(recent.length===80,'recent count');
  check(recent.at(-1).id===messages.at(-1).id,'recent last id');
  const clock=await db.messageSyncClock.get('singleton');
  return {count:rows.length,refs:await db.messageMediaRefs.count(),lastText:rows.at(-1).parts[0].text,clock:clock.revision};
 },
 async nineActiveSessions(){
  await db.delete();await db.open();
  const retained=[];
  for(let sessionIndex=0;sessionIndex<9;sessionIndex++){
   const sessionId='retained-'+sessionIndex;invalidatePersistSnapshot(sessionId);
   await db.sessions.put({id:sessionId,projectId:'bench-project',createdAt:1,updatedAt:1});
   const transcript=Array.from({length:1000},(_,index)=>({id:sessionId+'-'+index,role:index%2?'assistant':'user',parts:[{type:'text',text:'x'.repeat(2048)}],metadata:{triggerWorkflows:false}}));
   retained.push({sessionId,transcript});await persistMessages(sessionId,transcript);
  }
  let fullSessionQueries=0;
  const where=db.messages.where;
  db.messages.where=function(index){if(index==='sessionId')fullSessionQueries++;return where.call(this,index)};
  const rawMs=[];
  try{
   for(let sample=-2;sample<10;sample++){
    for(const entry of retained){const previous=entry.transcript.at(-1);entry.transcript=[...entry.transcript.slice(0,-1),{...previous,parts:[{type:'text',text:'sample:'+sample}]}]}
    const started=performance.now();await Promise.all(retained.map(entry=>persistStreamingMessages(entry.sessionId,entry.transcript)));const elapsed=performance.now()-started;if(sample>=0)rawMs.push(elapsed);
   }
  }finally{db.messages.where=where}
  check(await db.messages.count()===9000,'nine-active row count');
  for(const entry of retained){const row=await db.messages.get(entry.transcript.at(-1).id);check(row.parts[0].text==='sample:9','nine-active latest content')}
  check(fullSessionQueries===0,'nine-active full-session query fallback');
  const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return (sorted[4]+sorted[5])/2};
  const medianMs=median(rawMs);
  return {sessions:9,messagesPerSession:1000,warmup:2,samples:10,operation:'Promise.all of nine trailing-row streaming writes',fullSessionQueries,count:9000,medianMs,madMs:median(rawMs.map(value=>Math.abs(value-medianMs))),rawMs};
 },
 async startContinuousStream(){
  const old=messages.at(-1);messages=[...messages.slice(0,-1),{...old,parts:[{type:'text',text:'token:0'},...old.parts.slice(1)],metadata:{...old.metadata,streamToken:0,streamElapsedMs:0}}];
  await persistStreamingMessages(sid,messages);
  const start=performance.now();
  const state={produced:0,requested:[],committed:[],errors:[],start};
  window.streamState=state;
  const registry=new SessionCoalescingRegistry({persistDelayMs:300,onCommit:()=>{},onPersist:(sessionId,snapshot)=>{
   state.requested.push({token:snapshot.at(-1).metadata.streamToken,elapsedMs:performance.now()-start});
   void persistStreamingMessages(sessionId,snapshot).then(()=>state.committed.push({token:snapshot.at(-1).metadata.streamToken,elapsedMs:performance.now()-start})).catch(e=>state.errors.push(String(e)));
  }});
  const pair=registry.get(sid);
  setInterval(()=>{
   const previous=messages.at(-1);const streamToken=++state.produced;
   messages=[...messages.slice(0,-1),{...previous,parts:[{type:'text',text:'token:'+streamToken},...previous.parts.slice(1)],metadata:{...previous.metadata,streamToken,streamElapsedMs:performance.now()-start}}];
   pair.persist.call(messages);
  },10);
 },
 streamStatus(){const state=window.streamState;return {...state,elapsedMs:performance.now()-state.start};},
 async continuousRecoveryVerify(){
  const count=await db.messages.count();const refs=await db.messageMediaRefs.count();
  const row=await db.messages.get('msg-00000999');
  check(count===1000,'stream-crash row count');check(refs===1000,'stream-crash ref count');
  check(row.parts[0].text==='token:'+row.metadata.streamToken,'stream-crash text metadata consistency');
  return {count,refs,recoveredToken:row.metadata.streamToken,recoveredTokenElapsedMs:row.metadata.streamElapsedMs,clock:(await db.messageSyncClock.get('singleton')).revision};
 },
 async ledgerMutationVerify(){
  const counts={creating:0,updating:0,deleting:0};
  const create=()=>{counts.creating++};const update=()=>{counts.updating++};const remove=()=>{counts.deleting++};
  db.messageMediaRefs.hook('creating',create);db.messageMediaRefs.hook('updating',update);db.messageMediaRefs.hook('deleting',remove);
  try{
   const old=messages.at(-1);messages[messages.length-1]={...old,parts:[{type:'text',text:'guard-stream-'+'x'.repeat(2035)},...old.parts.slice(1)]};
   await persistStreamingMessages(sid,messages);
  }finally{db.messageMediaRefs.hook('creating').unsubscribe(create);db.messageMediaRefs.hook('updating').unsubscribe(update);db.messageMediaRefs.hook('deleting').unsubscribe(remove)}
  return counts;
 },
 async rollbackVerify(){
  const old=await db.messages.get('msg-00000000');
  const oldClock=(await db.messageSyncClock.get('singleton')).revision;
  let aborted=false;
  try{await db.transaction('rw',db.messages,db.messageMediaRefs,db.sessions,async()=>{
   await db.messages.put({...old,parts:[{type:'text',text:'must rollback'}]});
   await db.messageMediaRefs.put({messageId:old.id,sessionId:sid,hash:'must-rollback'});
   await db.sessions.update(sid,{transcriptRevision:999999});
   throw Error('intentional rollback');
  });}catch(e){if(e.message!=='intentional rollback')throw e;aborted=true}
  check(aborted,'rollback fired');
  check((await db.messages.get(old.id)).parts[0].text===old.parts[0].text,'aborted row restored');
  check((await db.messageSyncClock.get('singleton')).revision===oldClock,'aborted sync clock restored');
  check(!(await db.messageMediaRefs.get([old.id,'must-rollback'])),'aborted ref restored');
  check((await db.sessions.get(sid)).transcriptRevision!==999999,'aborted session restored');
  return {aborted:true,rowRestored:true,clockRestored:true,refRestored:true,sessionRestored:true};
 },
 async reopenVerify(expected){
  const rows=await listMessages(sid);
  check(rows.length===expected.count,'reload row count');check(rows.at(-1).parts[0].text===expected.lastText,'reload last text');
  check(await db.messageMediaRefs.count()===expected.refs,'reload ref count');
  check((await db.messageSyncClock.get('singleton')).revision===expected.clock,'reload sync clock');
  return {count:rows.length,refs:expected.refs,clock:expected.clock};
 }
};`
;(async () => {
  const build = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    tsconfig: path.join(root, "tsconfig.json"),
    nodePaths: [path.join(root, "node_modules")],
    plugins: [
      {
        name: "isolated-harness-boundaries",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            // Keep archived bytes outside TypeScript compilation while resolving their original imports.
            const virtualArchivePath = path.isAbsolute(args.path)
              ? args.path
              : args.namespace === "archive" && args.path.startsWith(".")
                ? path.resolve(args.resolveDir, args.path) + (path.extname(args.path) ? "" : ".ts")
                : null
            if (
              virtualArchivePath?.startsWith(archiveRoot + path.sep) &&
              fs.existsSync(virtualArchivePath + ".txt")
            )
              return { path: virtualArchivePath, namespace: "archive" }
            if (
              args.path === "benchmark-schema" ||
              args.path === "./schema" ||
              args.path === "@/lib/db/schema"
            )
              return { path: "schema", namespace: "bench" }
            if (stub[args.path]) return { path: args.path, namespace: "stub" }
            if (args.path === "./project-scope") return { path: "project", namespace: "bench" }
            if (args.path === "./ingest-media") return { path: "ingest", namespace: "bench" }
            if (
              args.path.startsWith("@/lib/db/") ||
              args.path === "@/lib/chat/media/normalize-message-media"
            ) {
              const rel = args.path.slice(2) + ".ts"
              const candidate = path.join(source, rel)
              if (variant === "baseline" && fs.existsSync(candidate + ".txt"))
                return { path: candidate, namespace: "archive" }
              if (fs.existsSync(candidate)) return { path: candidate }
            }
          })
          b.onLoad({ filter: /\.ts$/, namespace: "archive" }, (args) => ({
            contents:
              args.path === messagePath
                ? capturedMessages
                : args.path === coalescerPath
                  ? capturedCoalescer
                  : fs.readFileSync(args.path + ".txt", "utf8"),
            loader: "ts",
            resolveDir: path.dirname(args.path),
          }))
          b.onLoad({ filter: /\.ts$/, namespace: "file" }, (args) =>
            args.path === messagePath
              ? { contents: capturedMessages, loader: "ts", resolveDir: path.dirname(messagePath) }
              : args.path === coalescerPath
                ? {
                    contents: capturedCoalescer,
                    loader: "ts",
                    resolveDir: path.dirname(coalescerPath),
                  }
                : undefined
          )
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stub[args.path],
            loader: "ts",
            resolveDir: root,
          }))
          b.onLoad({ filter: /.*/, namespace: "bench" }, (args) => ({
            contents:
              args.path === "schema"
                ? schema
                : args.path === "project"
                  ? 'export const resolveScopeProjectId=async()=>"bench-project";'
                  : 'export const ingestImageDataUrl=()=>{throw Error("unsupported inline ingestion")};',
            loader: "ts",
            resolveDir: root,
          }))
        },
      },
    ],
  })
  const bundle = build.outputFiles[0].text
  fs.writeFileSync(path.join(dir, variant + ".bundle.js"), bundle)
  fs.writeFileSync(path.join(dir, variant + ".messages.ts.txt"), capturedMessages)
  fs.writeFileSync(path.join(dir, variant + ".stream-coalescing.ts.txt"), capturedCoalescer)
  if (process.argv.includes("--bundle-only")) return
  const server = http.createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/bundle.js" ? "application/javascript" : "text/html"
    )
    response.end(
      request.url === "/bundle.js" ? bundle : '<!doctype html><script src="/bundle.js"></script>'
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  let page = await context.newPage()
  const url = "http://127.0.0.1:" + server.address().port
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const n = sorted.length
    return (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2
  }
  const report = {
    variant,
    date: new Date().toISOString(),
    browser: browser.version(),
    platform: process.platform,
    arch: process.arch,
    samples: 10,
    warmup: 2,
    criterion:
      "improvement >=20% and absolute median difference >2*max(MAD before,MAD after), all correctness guards pass",
    scope:
      "Real Chromium IndexedDB, Dexie 4.4.5, unchanged production message-sync middleware, production messages/media normalization/session assets/ref ledger. Reduced schema with identical message/session/ref indexes. No encryption, full app UI, Tauri, workflow/indexer/publication/claim side effects, original blob ingestion or schema migrations.",
    sourceSha256: crypto.createHash("sha256").update(capturedMessages).digest("hex"),
    workloads: [],
  }
  try {
    await page.goto(url)
    await page.waitForFunction(() => !!window.bench)
    for (const count of process.argv.includes("--recovery-only") ? [] : [1000, 10000])
      for (const attachments of [false, true]) {
        const seed = await page.evaluate(
          async ({ count, attachments }) => window.bench.setup(count, attachments),
          { count, attachments }
        )
        const workload = { count, textBytesPerMessage: 2048, attachments, seed, metrics: {} }
        for (const kind of [
          "unchanged",
          "full-change",
          "streaming",
          "restore-recent",
          "restore-all",
        ]) {
          const raw = []
          for (let i = -2; i < 10; i++) {
            const ms = await page.evaluate(async ({ kind, i }) => window.bench.run(kind, i), {
              kind,
              i,
            })
            if (i >= 0) raw.push(ms)
          }
          const med = median(raw)
          workload.metrics[kind] = {
            medianMs: med,
            madMs: median(raw.map((x) => Math.abs(x - med))),
            rawMs: raw,
          }
        }
        const expected = await page.evaluate(
          async ({ count, attachments }) => window.bench.verify(count, attachments),
          { count, attachments }
        )
        await page.reload()
        await page.waitForFunction(() => !!window.bench)
        workload.reopen = await page.evaluate(
          (expected) => window.bench.reopenVerify(expected),
          expected
        )
        report.workloads.push(workload)
        console.log(
          JSON.stringify({ count, attachments, metrics: workload.metrics, reopen: workload.reopen })
        )
        fs.writeFileSync(
          path.join(dir, variant + resultSuffix + ".json"),
          JSON.stringify(report, null, 2) + "\n"
        )
      }
    report.nineActiveSessions = await page.evaluate(() => window.bench.nineActiveSessions())
    await page.evaluate(() => window.bench.setup(1000, true))
    report.unchangedMediaLedgerMutations = await page.evaluate(() =>
      window.bench.ledgerMutationVerify()
    )
    report.rollback = await page.evaluate(() => window.bench.rollbackVerify())
    const expected = await page.evaluate(() => window.bench.verify(1000, true))
    const cdp = await context.newCDPSession(page)
    const crash = page.waitForEvent("crash", { timeout: 10000 })
    void cdp.send("Page.crash").catch(() => {})
    await crash
    const crashed = page
    page = await context.newPage()
    await crashed.close()
    await page.goto(url)
    await page.waitForFunction(() => !!window.bench)
    report.rendererCrashRecovery = await page.evaluate(
      (expected) => window.bench.reopenVerify(expected),
      expected
    )
    fs.writeFileSync(
      path.join(
        dir,
        variant +
          resultSuffix +
          (process.argv.includes("--recovery-only") ? ".recovery" : "") +
          ".json"
      ),
      JSON.stringify(report, null, 2) + "\n"
    )
    await page.evaluate(() => window.bench.setup(1000, true))
    await page.evaluate(() => window.bench.startContinuousStream())
    await page.waitForTimeout(3150)
    const beforeCrash = await page.evaluate(() => window.bench.streamStatus())
    const streamCdp = await context.newCDPSession(page)
    const streamCrash = page.waitForEvent("crash", { timeout: 10000 })
    void streamCdp.send("Page.crash").catch(() => {})
    await streamCrash
    const streamCrashedPage = page
    page = await context.newPage()
    await streamCrashedPage.close()
    await page.goto(url)
    await page.waitForFunction(() => !!window.bench)
    const recovered = await page.evaluate(() => window.bench.continuousRecoveryVerify())
    report.continuousStreamCrash = {
      targetEventsPerSecond: 100,
      persistDelayMs: 300,
      observationDurationMs: beforeCrash.elapsedMs,
      producedBeforeCrash: beforeCrash.produced,
      checkpointRequests: beforeCrash.requested,
      checkpointCommits: beforeCrash.committed,
      errors: beforeCrash.errors,
      ...recovered,
      observedTokenLoss: beforeCrash.produced - recovered.recoveredToken,
      observedLagMs: beforeCrash.elapsedMs - recovered.recoveredTokenElapsedMs,
    }
    report.coalescerSha256 = crypto.createHash("sha256").update(capturedCoalescer).digest("hex")
    fs.writeFileSync(
      path.join(
        dir,
        variant +
          resultSuffix +
          (process.argv.includes("--recovery-only") ? ".recovery" : "") +
          ".json"
      ),
      JSON.stringify(report, null, 2) + "\n"
    )
    console.log(
      JSON.stringify({
        nineActiveSessions: report.nineActiveSessions,
        continuousStreamCrash: report.continuousStreamCrash,
      })
    )
    console.log(
      JSON.stringify({
        unchangedMediaLedgerMutations: report.unchangedMediaLedgerMutations,
        rollback: report.rollback,
        rendererCrashRecovery: report.rendererCrashRecovery,
      })
    )
  } finally {
    await context.close()
    await browser.close()
    server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
