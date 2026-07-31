/**
 * Tests for the sidecar `LspService`. Injects a fake `CogniaLspClient`
 * ctor so the service can be exercised without real subprocesses.
 *
 * Run via `pnpm sidecar:test` after `pnpm --filter
 * @cognia/vscode-ext-host build`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

const { LspService } = await import("../dist/lsp-service.js")

function makeFakeClientCtor() {
  const created = []
  class FakeLspClient {
    static created = created
    constructor(opts) {
      this.opts = opts
      this.state = "stopped"
      this.diagnosticsListener = null
      this.didOpenCalls = []
      this.didChangeCalls = []
      this.didCloseCalls = []
      this.requestCalls = []
      this.notificationCalls = []
      this.stopped = false
      created.push(this)
    }
    getState() {
      return this.state
    }
    getServerCapabilities() {
      return null
    }
    getDocumentVersion(uri) {
      return this.didOpenCalls.some((call) => call.uri === uri) ? 1 : null
    }
    async start() {
      this.state = "running"
    }
    async stop() {
      this.state = "stopped"
      this.stopped = true
    }
    onPublishDiagnostics(cb) {
      this.diagnosticsListener = cb
      return () => {
        this.diagnosticsListener = null
      }
    }
    registerTextDocument(uri, languageId, text) {
      this.didOpenCalls.push({ uri, languageId, text })
    }
    changeTextDocument(uri, text) {
      this.didChangeCalls.push({ uri, text })
    }
    closeTextDocument(uri) {
      this.didCloseCalls.push({ uri })
    }
    async completion(uri, position) {
      this.requestCalls.push({ method: "completion", uri, position })
      return [{ label: "fake" }]
    }
    async hover(uri, position) {
      this.requestCalls.push({ method: "hover", uri, position })
      return { contents: "fake hover" }
    }
    async definition(uri, position) {
      this.requestCalls.push({ method: "definition", uri, position })
      return []
    }
    async references(uri, position) {
      this.requestCalls.push({ method: "references", uri, position })
      return []
    }
    async formatting(uri) {
      this.requestCalls.push({ method: "formatting", uri })
      return []
    }
    async rangeFormatting(uri, range) {
      this.requestCalls.push({ method: "rangeFormatting", uri, range })
      return []
    }
    async codeActions(uri, range, diagnostics) {
      this.requestCalls.push({ method: "codeActions", uri, range, diagnostics })
      return []
    }
    async signatureHelp(uri, position) {
      this.requestCalls.push({ method: "signatureHelp", uri, position })
      return null
    }
    async documentSymbol(uri) {
      this.requestCalls.push({ method: "documentSymbol", uri })
      return []
    }
    async rename(uri, position, newName) {
      this.requestCalls.push({ method: "rename", uri, position, newName })
      return { changes: {} }
    }
    async foldingRange(uri) {
      this.requestCalls.push({ method: "foldingRange", uri })
      return []
    }
    async semanticTokens(uri) {
      this.requestCalls.push({ method: "semanticTokens", uri })
      return { data: [] }
    }
    async requestRaw(method, params) {
      this.requestCalls.push({ method, params })
      return { method, params }
    }
    notifyRaw(method, params) {
      this.notificationCalls.push({ method, params })
    }
  }
  return { ctor: FakeLspClient, created }
}

function makeService() {
  const { ctor, created } = makeFakeClientCtor()
  const notifications = []
  const service = new LspService(
    (method, params) => notifications.push({ method, params }),
    {},
    ctor
  )
  return { service, ctor, created, notifications }
}

test("start() constructs a CogniaLspClient with the right options and transitions to running", async () => {
  const { service, created } = makeService()
  const result = await service.start({
    ownerId: "user",
    serverId: "eslint",
    command: "/x/eslint-server",
    args: ["--stdio"],
    workspaceFolders: [{ uri: "file:///tmp/w", name: "w" }],
  })
  assert.equal(result.state, "running")
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].opts.workspaceFolders, [{ uri: "file:///tmp/w", name: "w" }])
})

test("start() is idempotent when the same key is already running", async () => {
  const { service, created } = makeService()
  await service.start({
    ownerId: "user",
    serverId: "eslint",
    command: "/x/eslint-server",
  })
  const second = await service.start({
    ownerId: "user",
    serverId: "eslint",
    command: "/x/eslint-server",
  })
  assert.equal(second.state, "running")
  assert.equal(created.length, 1, "only one client should be constructed")
})

test("publishDiagnostics from the client → connection.sendNotification('lsp:publishDiagnostics')", async () => {
  const { service, created, notifications } = makeService()
  await service.start({
    ownerId: "user",
    serverId: "eslint",
    command: "/x",
  })
  const client = created[0]
  const diagnostic = {
    severity: 1,
    message: "boom",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  }
  client.diagnosticsListener({
    uri: "file:///foo.ts",
    // Same diagnostic twice — the buffer dedupes before publishing.
    diagnostics: [diagnostic, { ...diagnostic }],
  })
  // Frames are debounced (150ms) — wait for the buffer to flush.
  await new Promise((r) => setTimeout(r, 250))
  const published = notifications.filter((n) => n.method === "lsp:publishDiagnostics")
  assert.equal(published.length, 1)
  assert.equal(published[0].params.ownerId, "user")
  assert.equal(published[0].params.serverId, "eslint")
  assert.equal(published[0].params.diagnostics.length, 1, "duplicates are dropped")
})

test("server requests are correlated, carry workspace-edit preconditions, and accept responses", async () => {
  const { service, created, notifications } = makeService()
  await service.start({ ownerId: "managed-pro:acme", serverId: "ts", command: "/x" })
  service.didOpen({
    ownerId: "managed-pro:acme",
    serverId: "ts",
    uri: "file:///workspace/a.ts",
    languageId: "typescript",
    text: "const value = 1\n",
  })

  const pending = created[0].opts.handleServerRequest("workspace/applyEdit", {
    edit: {
      changes: {
        "file:///workspace/a.ts": [
          {
            range: {
              start: { line: 0, character: 14 },
              end: { line: 0, character: 15 },
            },
            newText: "2",
          },
        ],
      },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const forwarded = notifications.find((item) => item.method === "lsp:serverRequest")
  assert.ok(forwarded)
  assert.equal(forwarded.params.method, "workspace/applyEdit")
  assert.equal(forwarded.params.preconditions["file:///workspace/a.ts"].version, 1)
  assert.match(
    forwarded.params.preconditions["file:///workspace/a.ts"].contentHash,
    /^[a-f0-9]{64}$/
  )

  assert.deepEqual(
    service.serverResponse({
      ownerId: "managed-pro:acme",
      serverId: "ts",
      requestId: forwarded.params.requestId,
      result: { applied: true },
    }),
    { accepted: true }
  )
  assert.deepEqual(await pending, { applied: true })
  assert.deepEqual(
    service.serverResponse({
      ownerId: "managed-pro:acme",
      serverId: "ts",
      requestId: forwarded.params.requestId,
      result: null,
    }),
    { accepted: false }
  )
})

test("server notifications are projected and pending requests fail on stop", async () => {
  const { service, created, notifications } = makeService()
  await service.start({ ownerId: "managed-pro:acme", serverId: "ts", command: "/x" })
  created[0].opts.handleServerNotification("$/progress", {
    token: "index",
    value: { kind: "report", message: "50%" },
  })
  assert.deepEqual(notifications.at(-1), {
    method: "lsp:serverNotification",
    params: {
      ownerId: "managed-pro:acme",
      serverId: "ts",
      method: "$/progress",
      payload: { token: "index", value: { kind: "report", message: "50%" } },
    },
  })

  const pending = created[0].opts.handleServerRequest("window/showMessageRequest", {
    type: 3,
    message: "Continue?",
    actions: [{ title: "Yes" }],
  })
  await service.stop("managed-pro:acme", "ts")
  await assert.rejects(() => pending, /LSP_CLIENT_STOPPED/)
})

test("client notifications are routed to the exact language-server session", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "managed-pro:acme", serverId: "ts", command: "/x" })
  assert.deepEqual(
    service.clientNotification({
      ownerId: "managed-pro:acme",
      serverId: "ts",
      method: "window/workDoneProgress/cancel",
      payload: { token: "index" },
    }),
    { accepted: true }
  )
  assert.deepEqual(created[0].notificationCalls, [
    { method: "window/workDoneProgress/cancel", params: { token: "index" } },
  ])
})

test("stop() tears the client down and unsubscribes diagnostics", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "user", serverId: "eslint", command: "/x" })
  const client = created[0]
  const result = await service.stop("user", "eslint")
  assert.deepEqual(result, { removed: true })
  assert.equal(client.stopped, true)
  assert.equal(client.diagnosticsListener, null)
})

test("stop() is idempotent on an unknown key", async () => {
  const { service } = makeService()
  const result = await service.stop("user", "missing")
  assert.deepEqual(result, { removed: false })
})

test("didOpen / didChange / didClose route to the underlying client", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "user", serverId: "eslint", command: "/x" })
  service.didOpen({
    ownerId: "user",
    serverId: "eslint",
    uri: "file:///foo.ts",
    languageId: "typescript",
    text: "const x = 1",
  })
  service.didChange({
    ownerId: "user",
    serverId: "eslint",
    uri: "file:///foo.ts",
    text: "const x = 2",
  })
  service.didClose({
    ownerId: "user",
    serverId: "eslint",
    uri: "file:///foo.ts",
  })
  const c = created[0]
  assert.equal(c.didOpenCalls.length, 1)
  assert.equal(c.didOpenCalls[0].languageId, "typescript")
  assert.equal(c.didChangeCalls.length, 1)
  assert.equal(c.didChangeCalls[0].text, "const x = 2")
  assert.equal(c.didCloseCalls.length, 1)
})

test("didOpen accepts an empty document", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "user", serverId: "eslint", command: "/x" })
  service.didOpen({
    ownerId: "user",
    serverId: "eslint",
    uri: "file:///empty.ts",
    languageId: "typescript",
    text: "",
  })
  assert.deepEqual(created[0].didOpenCalls.at(-1), {
    uri: "file:///empty.ts",
    languageId: "typescript",
    text: "",
  })
})

test("request() dispatches every supported LSP method to the matching client call", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "user", serverId: "eslint", command: "/x" })
  const expected = [
    "completion",
    "hover",
    "definition",
    "references",
    "formatting",
    "rangeFormatting",
    "codeActions",
    "signatureHelp",
    "documentSymbol",
    "rename",
    "foldingRange",
    "semanticTokens",
  ]
  for (const method of expected) {
    await service.request({
      ownerId: "user",
      serverId: "eslint",
      method,
      payload: {
        uri: "file:///foo.ts",
        position: { line: 0, character: 0 },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newName: "x",
      },
    })
  }
  const seen = created[0].requestCalls.map((c) => c.method)
  for (const m of expected) {
    assert.ok(seen.includes(m), `expected ${m} in ${seen.join(",")}`)
  }
})

test("request() forwards stable protocol method names through requestRaw", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "managed-pro:acme", serverId: "ts", command: "/x" })
  const payload = {
    textDocument: { uri: "file:///foo.ts" },
    position: { line: 1, character: 2 },
  }
  const result = await service.request({
    ownerId: "managed-pro:acme",
    serverId: "ts",
    method: "textDocument/declaration",
    payload,
  })
  assert.deepEqual(result, { method: "textDocument/declaration", params: payload })
  assert.deepEqual(created[0].requestCalls.at(-1), {
    method: "textDocument/declaration",
    params: payload,
  })
})

test("cancel() propagates through the JSON-RPC cancellation token", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "managed-pro:acme", serverId: "ts", command: "/x" })
  let resolveRequest
  let cancellationToken
  created[0].requestRaw = (_method, _params, token) => {
    cancellationToken = token
    return new Promise((resolve) => {
      resolveRequest = resolve
    })
  }
  const pending = service.request({
    ownerId: "managed-pro:acme",
    serverId: "ts",
    requestId: "broker-request-1",
    method: "textDocument/hover",
    payload: {},
  })
  assert.equal(service.cancel("managed-pro:acme", "ts", "broker-request-1"), true)
  assert.equal(cancellationToken.isCancellationRequested, true)
  resolveRequest(null)
  await pending
})

test("request() throws on an unknown method", async () => {
  const { service } = makeService()
  await service.start({ ownerId: "user", serverId: "eslint", command: "/x" })
  await assert.rejects(
    () =>
      service.request({
        ownerId: "user",
        serverId: "eslint",
        method: "nonexistent",
        payload: {},
      }),
    /unknown method 'nonexistent'/
  )
})

test("didOpen for an unknown server throws — caller must call start first", async () => {
  const { service } = makeService()
  assert.throws(
    () =>
      service.didOpen({
        ownerId: "user",
        serverId: "missing",
        uri: "file:///foo.ts",
        languageId: "ts",
        text: "",
      }),
    /no client registered for user:missing/
  )
})

test("stopAll() tears down every running server", async () => {
  const { service, created } = makeService()
  await service.start({ ownerId: "user", serverId: "a", command: "/x" })
  await service.start({ ownerId: "user", serverId: "b", command: "/y" })
  await service.stopAll()
  assert.equal(created[0].stopped, true)
  assert.equal(created[1].stopped, true)
  assert.equal(service.list().length, 0)
})

test("list() reflects every active server", async () => {
  const { service } = makeService()
  await service.start({ ownerId: "user", serverId: "a", command: "/x" })
  await service.start({ ownerId: "pub.lsp", serverId: "b", command: "/y" })
  const items = service.list()
  assert.equal(items.length, 2)
  assert.ok(items.find((i) => i.key === "user:a"))
  assert.ok(items.find((i) => i.key === "pub.lsp:b"))
})

test("start() failure cleans up the half-registered entry so retries can reattempt", async () => {
  const { service, created } = makeService()
  // First start throws; verify a subsequent start with the same key
  // can re-attempt.
  class BoomCtor {
    constructor(opts) {
      this.opts = opts
      this.state = "stopped"
      created.push(this)
    }
    getState() {
      return this.state
    }
    onPublishDiagnostics() {
      return () => {}
    }
    async start() {
      throw new Error("simulated spawn failure")
    }
    async stop() {}
  }
  const failingService = new LspService(() => {}, {}, BoomCtor)
  await assert.rejects(
    () => failingService.start({ ownerId: "user", serverId: "x", command: "/x" }),
    /simulated spawn failure/
  )
  // list should be empty (half-state was cleaned up).
  assert.equal(failingService.list().length, 0)
})

// ───────────────────────────────────────────────────────────────────────────
// Supervisor (crash → backoff restart → broken) + status/logs/detect/install
// ───────────────────────────────────────────────────────────────────────────

function makeSupervisedHarness() {
  const created = []
  // Mutable behavior switch: when true, every NEW client's start() rejects.
  const behavior = { failStarts: false }
  class SupervisedFakeClient {
    constructor(opts) {
      this.opts = opts
      this.state = "stopped"
      this.diagnosticsListener = null
      this.stateListener = null
      this.logListener = null
      this.didOpenCalls = []
      this.failStart = behavior.failStarts
      created.push(this)
    }
    getState() {
      return this.state
    }
    getServerCapabilities() {
      return null
    }
    getDocumentVersion() {
      return null
    }
    async start() {
      if (this.failStart) {
        this.state = "crashed"
        throw new Error("spawn ENOENT")
      }
      this.state = "running"
    }
    async stop() {
      this.state = "stopped"
    }
    onPublishDiagnostics(cb) {
      this.diagnosticsListener = cb
      return () => {
        this.diagnosticsListener = null
      }
    }
    onStateChange(cb) {
      this.stateListener = cb
      return () => {
        this.stateListener = null
      }
    }
    onLog(cb) {
      this.logListener = cb
      return () => {
        this.logListener = null
      }
    }
    registerTextDocument(uri, languageId, text) {
      this.didOpenCalls.push({ uri, languageId, text })
    }
    changeTextDocument() {}
    closeTextDocument() {}
    crash() {
      this.state = "crashed"
      this.stateListener?.("crashed")
    }
  }

  let nextId = 1
  const pendingTimers = new Map()
  const timers = {
    setTimeout: (cb, ms) => {
      const id = nextId++
      pendingTimers.set(id, { cb, ms })
      return id
    },
    clearTimeout: (id) => pendingTimers.delete(id),
  }
  const fireTimers = async () => {
    const entries = [...pendingTimers.values()]
    pendingTimers.clear()
    for (const { cb } of entries) cb()
    // restarts are async — let the microtask queue drain
    await new Promise((r) => setImmediate(r))
  }

  const notifications = []
  const service = new LspService(
    (method, params) => notifications.push({ method, params }),
    {},
    SupervisedFakeClient,
    timers
  )
  return { service, created, notifications, fireTimers, pendingTimers, behavior }
}

test("supervisor: crash schedules a backoff restart and replays open docs", async () => {
  const { service, created, fireTimers } = makeSupervisedHarness()
  await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  service.didOpen({
    ownerId: "agent",
    serverId: "ts",
    uri: "file:///a.ts",
    languageId: "typescript",
    text: "const a = 1",
  })

  created[0].crash()
  await fireTimers()

  assert.equal(created.length, 2, "a fresh client replaces the crashed one")
  assert.equal(created[1].state, "running")
  assert.deepEqual(created[1].didOpenCalls, [
    { uri: "file:///a.ts", languageId: "typescript", text: "const a = 1" },
  ])
  const status = service.status()
  assert.equal(status.length, 1)
  assert.equal(status[0].state, "running")
  assert.equal(status[0].restarts, 1)
})

test("supervisor: repeated failures end in 'broken'; manual start recovers", async () => {
  const { service, created, fireTimers, notifications, behavior } = makeSupervisedHarness()
  await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  behavior.failStarts = true // every restart attempt now fails
  created[0].crash()
  // Drive the backoff loop until the supervisor gives up (MAX_RESTARTS = 4).
  for (let i = 0; i < 6; i++) await fireTimers()

  const status = service.status()
  assert.equal(status[0].state, "broken")
  assert.equal(status[0].restarts, 4)
  assert.ok(status[0].lastError?.includes("ENOENT"))
  assert.ok(notifications.some((n) => n.method === "lsp:state" && n.params.state === "broken"))

  // Manual lsp:start resets the broken entry with a fresh client.
  behavior.failStarts = false // the user fixed the binary
  const before = created.length
  const result = await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  assert.equal(result.state, "running")
  assert.ok(created.length > before)
  assert.equal(service.status()[0].state, "running")
})

test("supervisor: stop() cancels a pending restart timer", async () => {
  const { service, created, pendingTimers } = makeSupervisedHarness()
  await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  created[0].crash()
  assert.equal(pendingTimers.size, 1, "restart scheduled")
  await service.stop("agent", "ts")
  assert.equal(pendingTimers.size, 0, "restart timer cancelled on stop")
})

test("logs(): ring buffer captures lifecycle + client log lines with filtering", async () => {
  const { service, created } = makeSupervisedHarness()
  await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  await service.start({ ownerId: "agent", serverId: "py", command: "/y" })
  created[0].logListener?.({ level: "warn", message: "tsserver stderr line" })

  const all = service.logs()
  assert.ok(all.some((e) => e.message.includes("started: /x")))
  assert.ok(all.some((e) => e.message === "tsserver stderr line"))

  const tsOnly = service.logs({ serverId: "ts" })
  assert.ok(tsOnly.every((e) => e.serverId === "ts"))
  const limited = service.logs({ limit: 1 })
  assert.equal(limited.length, 1)
})

test("status(): reflects state, restarts and startedAt", async () => {
  const { service } = makeSupervisedHarness()
  await service.start({ ownerId: "agent", serverId: "ts", command: "/x" })
  const [entry] = service.status()
  assert.equal(entry.ownerId, "agent")
  assert.equal(entry.serverId, "ts")
  assert.equal(entry.state, "running")
  assert.equal(entry.restarts, 0)
  assert.ok(typeof entry.startedAt === "number")
})
