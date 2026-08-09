import test from "node:test"
import assert from "node:assert/strict"

import {
  createHostSessionStore,
  sessionChainKey,
  serialize,
  sessionStoreFromSendOptions,
  storeScope,
  SUMMARY_CAS_ATTEMPTS,
} from "./session-store.mjs"

/**
 * A fake host that records calls and answers with whatever the test queued.
 * Summary state is modelled properly (version + CAS) because the CAS loop is
 * the part worth testing.
 */
function fakeHost({ failWrites = 0 } = {}) {
  const calls = []
  let summary = null
  let remainingFailures = failWrites
  return {
    calls,
    get summary() {
      return summary
    },
    call(method, params) {
      calls.push({ method, params })
      switch (method) {
        case "sessionStore.append":
          return Promise.resolve({ inserted: params.entries.length })
        case "sessionStore.load":
          return Promise.resolve({ entries: null })
        case "sessionStore.readSummary":
          return Promise.resolve({ summary })
        case "sessionStore.writeSummary": {
          if (remainingFailures > 0) {
            remainingFailures -= 1
            // Simulate a concurrent writer bumping the version under us.
            summary = { sessionId: params.sessionId, mtime: 1, data: {}, version: 99 }
            return Promise.resolve({ ok: false, conflict: true })
          }
          if ((summary?.version ?? undefined) !== params.expectedVersion) {
            return Promise.resolve({ ok: false, conflict: true })
          }
          summary = {
            sessionId: params.sessionId,
            mtime: 2,
            data: params.data,
            version: (summary?.version ?? 0) + 1,
          }
          return Promise.resolve({ ok: true, summary })
        }
        case "sessionStore.listSessions":
          return Promise.resolve({ sessions: [{ sessionId: "s1", mtime: 5 }] })
        case "sessionStore.listSummaries":
          return Promise.resolve({
            summaries: [{ sessionId: "s1", mtime: 5, data: { n: 1 }, version: 3 }],
          })
        case "sessionStore.listSubkeys":
          return Promise.resolve({ subkeys: ["subagents/agent-1"] })
        case "sessionStore.delete":
          return Promise.resolve({ removed: 1 })
        default:
          return Promise.reject(new Error(`unexpected ${method}`))
      }
    },
  }
}

const KEY = { projectKey: "proj", sessionId: "s1" }
const ENTRY = { type: "user", uuid: "a" }
const fold = (previous, key, entries) => ({
  sessionId: key.sessionId,
  mtime: 0,
  data: { count: (previous?.data?.count ?? 0) + entries.length },
})

const store = (host, extra = {}) =>
  createHostSessionStore({
    hostRpc: host,
    scope: { tenant: "t", workspace: "w" },
    foldSummary: fold,
    ...extra,
  })

// ---- scope ------------------------------------------------------------------

test("the scope comes from the frozen spec, never from the SDK key", () => {
  // `projectKey` is caller-supplied; deriving isolation from it would let a
  // crafted value reach another tenant's rows.
  assert.deepEqual(storeScope({ execution: { hostRef: "desktop-sidecar" }, cwd: "/w/a" }), {
    tenant: "desktop-sidecar",
    workspace: "/w/a",
  })
  assert.deepEqual(storeScope({ execution: { hostRef: "h", tenantId: "acme" }, cwd: "/w/a" }), {
    tenant: "acme",
    workspace: "/w/a",
  })
  // A send with no spec still gets a well-formed scope rather than undefined
  // columns, so rows can never land unscoped.
  assert.deepEqual(storeScope({}), { tenant: "default", workspace: "default" })
})

test("every call carries the scope", async () => {
  const host = fakeHost()
  await store(host).load(KEY)
  assert.deepEqual(host.calls[0].params.scope, { tenant: "t", workspace: "w" })
})

// ---- construction from the descriptor ----------------------------------------

test("a send with no descriptor gets no store at all", () => {
  assert.equal(sessionStoreFromSendOptions({}, { hostRpc: fakeHost() }), null)
  assert.equal(
    sessionStoreFromSendOptions({ claudeAgentSdk: { version: 1 } }, { hostRpc: fakeHost() }),
    null
  )
})

test("an unknown backend turns persistence OFF rather than picking a default", () => {
  // Silently persisting somewhere other than the caller asked is worse than
  // not persisting: they would believe the data is where they said.
  const warnings = []
  const built = sessionStoreFromSendOptions(
    { claudeAgentSdk: { sessionStore: { backend: "s3" } } },
    { hostRpc: fakeHost(), log: (_l, m) => warnings.push(m) }
  )
  assert.equal(built, null)
  assert.match(warnings.join("\n"), /unknown backend "s3"/)
})

test("a host with no host_rpc channel is reported, not silently ignored", () => {
  const warnings = []
  const built = sessionStoreFromSendOptions(
    { claudeAgentSdk: { sessionStore: { backend: "host-sqlite" } } },
    { hostRpc: null, log: (_l, m) => warnings.push(m) }
  )
  assert.equal(built, null)
  assert.match(warnings.join("\n"), /no host_rpc channel/)
})

test("a valid descriptor produces the full optional surface", () => {
  const built = sessionStoreFromSendOptions(
    { claudeAgentSdk: { sessionStore: { backend: "host-sqlite" } }, execution: { hostRef: "h" } },
    { hostRpc: fakeHost() }
  )
  // The SDK treats each optional method's ABSENCE as a capability gap:
  // no `listSubkeys` means resume silently drops subagent transcripts.
  for (const name of [
    "append",
    "load",
    "listSessions",
    "listSessionSummaries",
    "delete",
    "listSubkeys",
  ]) {
    assert.equal(typeof built[name], "function", name)
  }
})

// ---- append + summary --------------------------------------------------------

test("an empty batch never reaches the host", async () => {
  const host = fakeHost()
  await store(host).append(KEY, [])
  await store(host).append(KEY, null)
  assert.equal(host.calls.length, 0)
})

test("append writes the rows and then folds the summary", async () => {
  const host = fakeHost()
  await store(host).append(KEY, [ENTRY, ENTRY])
  assert.deepEqual(
    host.calls.map((c) => c.method),
    ["sessionStore.append", "sessionStore.readSummary", "sessionStore.writeSummary"]
  )
  assert.equal(host.summary.data.count, 2)
})

test("a subagent batch is stored but never folded into the parent's summary", async () => {
  // The fold describes the MAIN conversation; folding a subagent's turns in
  // would inflate counts for turns the user never sees in that thread.
  const host = fakeHost()
  await store(host).append({ ...KEY, subpath: "subagents/agent-1" }, [ENTRY])
  assert.deepEqual(
    host.calls.map((c) => c.method),
    ["sessionStore.append"]
  )
})

test("a losing CAS re-reads and re-folds instead of dropping the update", async () => {
  const host = fakeHost({ failWrites: 1 })
  await store(host).append(KEY, [ENTRY])
  const writes = host.calls.filter((c) => c.method === "sessionStore.writeSummary")
  assert.equal(writes.length, 2)
  // The retry folded from the version the conflict revealed, not from the
  // stale one — that is the whole point of the counter.
  assert.equal(writes[0].params.expectedVersion, undefined)
  assert.equal(writes[1].params.expectedVersion, 99)
  assert.equal(host.summary.version, 100)
})

test("a summary that never converges is logged, not thrown", async () => {
  // The transcript rows are already committed. Rejecting here would make the
  // SDK retry the whole batch and eventually emit `mirror_error` — reporting
  // data loss that did not happen.
  const host = fakeHost({ failWrites: 99 })
  const warnings = []
  await store(host, { log: (_l, m) => warnings.push(m) }).append(KEY, [ENTRY])
  assert.equal(
    host.calls.filter((c) => c.method === "sessionStore.writeSummary").length,
    SUMMARY_CAS_ATTEMPTS
  )
  assert.match(warnings.join("\n"), /gave up folding the summary/)
})

test("concurrent appends for one session are serialised", async () => {
  // The SDK batches at ~100ms and `flush: "eager"` makes every frame its own
  // batch, so overlapping appends are routine. Interleaved read-fold-writes
  // would lose one of the folds.
  const host = fakeHost()
  const s = store(host)
  await Promise.all([s.append(KEY, [ENTRY]), s.append(KEY, [ENTRY]), s.append(KEY, [ENTRY])])
  assert.equal(host.summary.data.count, 3)
  assert.equal(host.summary.version, 3)
})

test("a failed append does not poison the queue for the next one", async () => {
  let first = true
  const host = fakeHost()
  const original = host.call.bind(host)
  host.call = (method, params) => {
    if (method === "sessionStore.append" && first) {
      first = false
      return Promise.reject(new Error("disk full"))
    }
    return original(method, params)
  }
  const s = store(host)
  await assert.rejects(s.append(KEY, [ENTRY]), /disk full/)
  await s.append(KEY, [ENTRY])
  assert.equal(host.summary.data.count, 1)
})

// ---- reads -------------------------------------------------------------------

test("load turns the host's null into the SDK's `never written`", async () => {
  const host = fakeHost()
  assert.equal(await store(host).load(KEY), null)
})

test("listSessionSummaries strips the host-only version from SDK state", async () => {
  // `version` is our CAS bookkeeping. Leaking it into `SessionSummaryEntry`
  // would put a field the SDK does not know about into state it round-trips.
  const host = fakeHost()
  const rows = await store(host).listSessionSummaries("proj")
  assert.deepEqual(rows, [{ sessionId: "s1", mtime: 5, data: { n: 1 } }])
})

test("listSubkeys asks by ids, not by the whole key", async () => {
  const host = fakeHost()
  assert.deepEqual(await store(host).listSubkeys(KEY), ["subagents/agent-1"])
  assert.deepEqual(host.calls[0].params, {
    scope: { tenant: "t", workspace: "w" },
    projectKey: "proj",
    sessionId: "s1",
  })
})

// ---- the serialisation primitive ---------------------------------------------

test("sessionChainKey separates sessions but joins their subagents", () => {
  // Subagent appends must queue behind the main transcript's: they share the
  // session row that `delete` cascades over.
  assert.equal(sessionChainKey(KEY), sessionChainKey({ ...KEY, subpath: "subagents/x" }))
  assert.notEqual(sessionChainKey(KEY), sessionChainKey({ ...KEY, sessionId: "s2" }))
  // NUL-separated: the one byte a projectKey or session id cannot contain.
  assert.equal(sessionChainKey(undefined), "\u0000")
})

test("serialize runs tasks in order and drops the chain when idle", async () => {
  const chains = new Map()
  const order = []
  const slow = () => new Promise((r) => setTimeout(r, 5)).then(() => order.push("slow"))
  const fast = () => Promise.resolve().then(() => order.push("fast"))

  await Promise.all([serialize(chains, "k", slow), serialize(chains, "k", fast)])
  assert.deepEqual(order, ["slow", "fast"])
  // Left in place, the map would grow one entry per session for the process
  // lifetime.
  await Promise.resolve()
  assert.equal(chains.size, 0)
})

test("serialize keeps running after a rejected task", async () => {
  const chains = new Map()
  const order = []
  const boom = serialize(chains, "k", () => Promise.reject(new Error("nope")))
  const after = serialize(chains, "k", () => Promise.resolve(order.push("after")))
  await assert.rejects(boom, /nope/)
  await after
  assert.deepEqual(order, ["after"])
})

test("the dispatcher actually builds the store and hands it to query()", async () => {
  // Same anti-dormancy check as the prewarm pool: every unit test above would
  // still pass against a store that never reaches `options.sessionStore`.
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "anthropic.mjs"),
    "utf8"
  )
  assert.match(source, /sessionStoreFromSendOptions\(sendOptions/)
  assert.match(source, /options\.sessionStore = sessionStore/)
  // `sessionStoreFlush` is what makes `flush: "eager"` mean anything; without
  // it the descriptor's field is silently inert.
  assert.match(source, /options\.sessionStoreFlush = flush/)
})
