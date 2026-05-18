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
      this.stopped = false
      created.push(this)
    }
    getState() {
      return this.state
    }
    getServerCapabilities() {
      return null
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
  client.diagnosticsListener({
    uri: "file:///foo.ts",
    diagnostics: [
      {
        severity: 1,
        message: "boom",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
    ],
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].method, "lsp:publishDiagnostics")
  assert.equal(notifications[0].params.ownerId, "user")
  assert.equal(notifications[0].params.serverId, "eslint")
  assert.equal(notifications[0].params.diagnostics.length, 1)
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
