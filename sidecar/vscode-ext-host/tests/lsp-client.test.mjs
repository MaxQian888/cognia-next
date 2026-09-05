/**
 * In-process test for `CogniaLspClient`. Uses the connection-injection
 * seam to bypass `child_process.spawn` entirely — Windows stdio
 * buffering and process-lifecycle races would otherwise make the test
 * non-deterministic.
 *
 * The mock connection mimics `vscode-jsonrpc`'s
 * `MessageConnection` surface: `sendRequest`, `sendNotification`,
 * `onNotification`, `onError`, `onClose`, `listen`, `dispose`. Tests
 * drive the server side by calling `mock.simulateNotification(...)`
 * and `mock.replyTo(method, ...)`.
 *
 * Run via `pnpm sidecar:test` after `pnpm --filter
 * @cognia/vscode-ext-host build`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"

const { CogniaLspClient, selectConfigurationSection } = await import("../dist/lsp-client.js")

function makeMockConnection() {
  const notificationHandlers = new Map()
  const requestHandlers = new Map()
  const incomingRequestHandlers = new Map()
  const errorHandlers = []
  const closeHandlers = []
  const sentRequests = []
  const sentNotifications = []
  let listening = false
  let disposed = false

  const connection = {
    async sendRequest(method, params) {
      sentRequests.push({ method, params })
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`mock: no handler for request ${method}`)
      }
      return handler(params)
    },
    sendNotification(method, params) {
      sentNotifications.push({ method, params })
    },
    onNotification(method, cb) {
      notificationHandlers.set(method, cb)
    },
    onRequest(method, cb) {
      incomingRequestHandlers.set(method, cb)
    },
    onError(cb) {
      errorHandlers.push(cb)
    },
    onClose(cb) {
      closeHandlers.push(cb)
    },
    listen() {
      listening = true
    },
    dispose() {
      disposed = true
    },
  }

  return {
    connection,
    /** Wire up a canned reply to a specific client→server request. */
    replyTo(method, fn) {
      requestHandlers.set(method, fn)
    },
    /** Push a server→client notification — used to simulate publishDiagnostics. */
    simulateNotification(method, params) {
      const cb = notificationHandlers.get(method)
      if (!cb) throw new Error(`no handler bound for ${method}`)
      cb(params)
    },
    /** Invoke a server→client request handler (e.g. workspace/configuration). */
    simulateRequest(method, params) {
      const cb = incomingRequestHandlers.get(method)
      if (!cb) throw new Error(`no request handler bound for ${method}`)
      return cb(params)
    },
    simulateClose() {
      for (const cb of closeHandlers) cb()
    },
    inspect() {
      return { sentRequests, sentNotifications, listening, disposed }
    },
  }
}

function makeClient(mock, opts = {}) {
  return new CogniaLspClient(
    {
      serverId: "echo",
      command: "(mock)",
      transport: "stdio",
      workspaceFolders: [{ uri: "file:///tmp/echo", name: "echo" }],
      ...opts,
    },
    async () => ({
      connection: mock.connection,
      dispose: () => {},
    })
  )
}

const ECHO_CAPS = {
  textDocumentSync: 1,
  completionProvider: { triggerCharacters: ["."] },
  hoverProvider: true,
}

test("start() resolves with server capabilities and transitions to running", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS, serverInfo: { name: "echo" } }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  assert.equal(client.getState(), "running")
  assert.deepEqual(client.getServerCapabilities(), ECHO_CAPS)

  const sent = mock.inspect().sentRequests.map((r) => r.method)
  assert.ok(sent.includes("initialize"))
  const notif = mock.inspect().sentNotifications.map((n) => n.method)
  assert.ok(notif.includes("initialized"))

  await client.stop()
  assert.equal(client.getState(), "stopped")
})

test("stable server requests and notifications are projected to the IDE consumer", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)
  const requests = []
  const notifications = []
  const client = makeClient(mock, {
    handleServerRequest: async (method, params) => {
      requests.push({ method, params })
      return { applied: true }
    },
    handleServerNotification: (method, params) => {
      notifications.push({ method, params })
    },
  })

  await client.start()
  const result = await mock.simulateRequest("workspace/applyEdit", {
    label: "fix",
    edit: { changes: {} },
  })
  mock.simulateNotification("$/progress", { token: "index", value: { kind: "begin" } })

  assert.deepEqual(result, { applied: true })
  assert.deepEqual(requests, [
    {
      method: "workspace/applyEdit",
      params: { label: "fix", edit: { changes: {} } },
    },
  ])
  assert.deepEqual(notifications, [
    { method: "$/progress", params: { token: "index", value: { kind: "begin" } } },
  ])
  await client.stop()
})

test("server requests fail explicitly when no IDE consumer is installed", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)
  const client = makeClient(mock)
  await client.start()

  await assert.rejects(
    () => mock.simulateRequest("window/showDocument", { uri: "file:///tmp/a.ts" }),
    /LSP_CLIENT_METHOD_UNAVAILABLE/
  )
  await client.stop()
})

test("invalid language-server memory limits fail before transport creation", async () => {
  const mock = makeMockConnection()
  let constructed = false
  const client = new CogniaLspClient(
    {
      serverId: "invalid-limit",
      command: "(mock)",
      memoryLimitMb: 1,
    },
    async () => {
      constructed = true
      return { connection: mock.connection, dispose() {} }
    }
  )
  await assert.rejects(() => client.start(), /IDE_PROTOCOL_MEMORY_LIMIT_INVALID/)
  assert.equal(constructed, false)
})

test("socket transport connects only to the declared loopback endpoint", async () => {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd < 0) return
        const header = buffer.subarray(0, headerEnd).toString("ascii")
        const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
        const frameEnd = headerEnd + 4 + length
        if (!Number.isSafeInteger(length) || buffer.length < frameEnd) return
        const message = JSON.parse(buffer.subarray(headerEnd + 4, frameEnd).toString("utf8"))
        buffer = buffer.subarray(frameEnd)
        if (message.method === "initialize" || message.method === "shutdown") {
          const result = message.method === "initialize" ? { capabilities: ECHO_CAPS } : null
          const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
          socket.write(`Content-Length: ${body.length}\r\n\r\n`)
          socket.write(body)
        }
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const client = new CogniaLspClient({
    serverId: "socket",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    transport: "socket",
    endpoint: `tcp://127.0.0.1:${address.port}`,
  })
  try {
    await client.start()
    assert.equal(client.getState(), "running")
    await client.stop()
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("socket transport rejects remote and credential-bearing endpoints", async () => {
  for (const endpoint of [
    "tcp://example.com:5007",
    "tcp://user:secret@127.0.0.1:5007",
    "http://127.0.0.1:5007",
  ]) {
    const client = new CogniaLspClient({
      serverId: "unsafe-socket",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      transport: "socket",
      endpoint,
      startupTimeout: 100,
    })
    await assert.rejects(() => client.start(), /LSP_SOCKET_ENDPOINT_INVALID/)
    await client.stop()
  }
})

test("start() is idempotent — concurrent calls share the same promise", async () => {
  const mock = makeMockConnection()
  let initCalls = 0
  mock.replyTo("initialize", () => {
    initCalls += 1
    return { capabilities: ECHO_CAPS }
  })
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  const [a, b] = await Promise.all([client.start(), client.start()])
  assert.equal(a, undefined)
  assert.equal(b, undefined)
  assert.equal(initCalls, 1)

  await client.stop()
})

test("completion / hover / definition / references / formatting requests reach the server", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)
  mock.replyTo("textDocument/completion", () => [{ label: "echo", kind: 3 }])
  mock.replyTo("textDocument/hover", () => ({ contents: { kind: "markdown", value: "echo" } }))
  mock.replyTo("textDocument/definition", () => [])
  mock.replyTo("textDocument/references", () => [])
  mock.replyTo("textDocument/formatting", () => [])
  mock.replyTo("textDocument/rangeFormatting", () => [])
  mock.replyTo("textDocument/codeAction", () => [])
  mock.replyTo("textDocument/signatureHelp", () => null)
  mock.replyTo("textDocument/documentSymbol", () => [])
  mock.replyTo("textDocument/rename", () => ({ changes: {} }))
  mock.replyTo("textDocument/foldingRange", () => [])
  mock.replyTo("textDocument/semanticTokens/full", () => ({ data: [] }))

  const client = makeClient(mock)
  await client.start()
  client.registerTextDocument("file:///foo.txt", "plaintext", "x")

  const completion = await client.completion("file:///foo.txt", { line: 0, character: 0 })
  assert.equal(completion[0].label, "echo")

  const hover = await client.hover("file:///foo.txt", { line: 0, character: 0 })
  assert.match(hover.contents.value, /echo/)

  await client.definition("file:///foo.txt", { line: 0, character: 0 })
  await client.references("file:///foo.txt", { line: 0, character: 0 })
  await client.formatting("file:///foo.txt")
  await client.rangeFormatting("file:///foo.txt", {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  })
  await client.codeActions("file:///foo.txt", {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  })
  await client.signatureHelp("file:///foo.txt", { line: 0, character: 0 })
  await client.documentSymbol("file:///foo.txt")
  await client.rename("file:///foo.txt", { line: 0, character: 0 }, "new")
  await client.foldingRange("file:///foo.txt")
  await client.semanticTokens("file:///foo.txt")

  const sent = mock.inspect().sentRequests.map((r) => r.method)
  for (const required of [
    "initialize",
    "textDocument/completion",
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/references",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/codeAction",
    "textDocument/signatureHelp",
    "textDocument/documentSymbol",
    "textDocument/rename",
    "textDocument/foldingRange",
    "textDocument/semanticTokens/full",
  ]) {
    assert.ok(sent.includes(required), `missing ${required} in ${sent.join(", ")}`)
  }

  await client.stop()
})

test("controlled two-file workspace preserves diagnostics and cross-file language features", async () => {
  const mock = makeMockConnection()
  const aUri = "file:///tmp/skill/scripts/a.ts"
  const bUri = "file:///tmp/skill/scripts/b.ts"
  mock.replyTo("initialize", () => ({
    capabilities: {
      textDocumentSync: 1,
      completionProvider: {},
      definitionProvider: true,
      renameProvider: true,
      documentFormattingProvider: true,
    },
  }))
  mock.replyTo("shutdown", () => null)
  mock.replyTo("textDocument/completion", ({ textDocument }) => {
    assert.equal(textDocument.uri, aUri)
    return [{ label: "sharedValue", kind: 6 }]
  })
  mock.replyTo("textDocument/definition", ({ textDocument }) => {
    assert.equal(textDocument.uri, aUri)
    return [
      {
        uri: bUri,
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 24 },
        },
      },
    ]
  })
  mock.replyTo("textDocument/rename", ({ textDocument, newName }) => {
    assert.equal(textDocument.uri, aUri)
    assert.equal(newName, "renamedValue")
    return {
      changes: {
        [aUri]: [
          {
            range: {
              start: { line: 0, character: 9 },
              end: { line: 0, character: 20 },
            },
            newText: newName,
          },
        ],
        [bUri]: [
          {
            range: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 24 },
            },
            newText: newName,
          },
        ],
      },
    }
  })
  mock.replyTo("textDocument/formatting", ({ textDocument }) => {
    assert.equal(textDocument.uri, bUri)
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 31 },
        },
        newText: "export const sharedValue = 1\n",
      },
    ]
  })

  const client = makeClient(mock)
  const diagnostics = []
  client.onPublishDiagnostics((params) => diagnostics.push(params))
  await client.start()
  client.registerTextDocument(aUri, "typescript", "export { sharedValue } from './b'\n")
  client.registerTextDocument(bUri, "typescript", "export const sharedValue=1\n")

  mock.simulateNotification("textDocument/publishDiagnostics", {
    uri: bUri,
    diagnostics: [
      {
        range: {
          start: { line: 0, character: 24 },
          end: { line: 0, character: 25 },
        },
        severity: 2,
        message: "missing spacing",
      },
    ],
  })
  assert.equal(diagnostics[0].uri, bUri)

  const completion = await client.completion(aUri, { line: 0, character: 9 })
  const definition = await client.definition(aUri, { line: 0, character: 9 })
  const rename = await client.rename(aUri, { line: 0, character: 9 }, "renamedValue")
  const formatting = await client.formatting(bUri)

  assert.equal(completion[0].label, "sharedValue")
  assert.equal(definition[0].uri, bUri)
  assert.deepEqual(Object.keys(rename.changes).sort(), [aUri, bUri])
  assert.equal(formatting[0].newText, "export const sharedValue = 1\n")

  await client.stop()
})

test("publishDiagnostics notifications fan out to every subscriber", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()

  const received = []
  client.onPublishDiagnostics((p) => received.push(p))
  mock.simulateNotification("textDocument/publishDiagnostics", {
    uri: "file:///foo.txt",
    diagnostics: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 1,
        message: "boom",
      },
    ],
  })
  assert.equal(received.length, 1)
  assert.equal(received[0].uri, "file:///foo.txt")
  assert.equal(received[0].diagnostics[0].severity, 1)

  await client.stop()
})

test("registerTextDocument / changeTextDocument / closeTextDocument fire didOpen / didChange / didClose", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  client.registerTextDocument("file:///foo.txt", "ts", "v1")
  client.changeTextDocument("file:///foo.txt", "v2")
  client.changeTextDocument("file:///foo.txt", "v3")
  client.closeTextDocument("file:///foo.txt")

  const sent = mock.inspect().sentNotifications
  const didOpen = sent.find((n) => n.method === "textDocument/didOpen")
  assert.ok(didOpen)
  assert.equal(didOpen.params.textDocument.languageId, "ts")
  assert.equal(didOpen.params.textDocument.version, 1)

  const didChanges = sent.filter((n) => n.method === "textDocument/didChange")
  assert.equal(didChanges.length, 2)
  assert.equal(didChanges[0].params.textDocument.version, 2)
  assert.equal(didChanges[1].params.textDocument.version, 3)

  const didClose = sent.find((n) => n.method === "textDocument/didClose")
  assert.ok(didClose)

  await client.stop()
})

test("changeTextDocument before registerTextDocument auto-registers (best-effort)", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  client.changeTextDocument("file:///foo.txt", "v1")

  const sent = mock.inspect().sentNotifications
  // didOpen should have been synthesised even though the caller skipped
  // the explicit register call.
  const didOpen = sent.find((n) => n.method === "textDocument/didOpen")
  assert.ok(didOpen)
  assert.equal(didOpen.params.textDocument.languageId, "plaintext")

  await client.stop()
})

test("invoking a provider before start() throws with a clear error", async () => {
  const mock = makeMockConnection()
  const client = makeClient(mock)
  await assert.rejects(
    () => client.completion("file:///foo.txt", { line: 0, character: 0 }),
    /cannot run RPC in state 'stopped'/
  )
})

test("stop() is idempotent on a stopped client", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  await client.stop()
  await client.stop() // second stop must not throw
  assert.equal(client.getState(), "stopped")
})

test("stop() survives a slow shutdown response (uses the 5s timeout fallback)", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  // shutdown that never resolves
  mock.replyTo("shutdown", () => new Promise(() => {}))

  const client = makeClient(mock)
  await client.start()
  // Don't actually wait 5 real seconds — pre-emptively force cleanup
  // via a second call that should still drive state to "stopped"
  // because the first stop's timeout fires asynchronously.
  const stopPromise = client.stop()
  // The first stop is awaiting the 5s timeout race; resolve by closing.
  mock.simulateClose()
  await stopPromise
  assert.equal(client.getState(), "stopped")
})

test("onError handlers from the underlying connection do not crash the client", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  // We assert that registering an onError handler is wired — the
  // observable side-effect is that the client survives the simulated
  // connection close without rejecting any in-flight promise.
  mock.simulateClose()
  // After the connection closes, the client should be in a non-running state.
  assert.notEqual(client.getState(), "running")
})

test("selectConfigurationSection resolves dotted sections, whole object, and missing paths", () => {
  const settings = { "rust-analyzer": { cargo: { features: "all" } }, top: 1 }
  assert.deepEqual(selectConfigurationSection(settings, "rust-analyzer.cargo"), { features: "all" })
  assert.equal(selectConfigurationSection(settings, "rust-analyzer.cargo.features"), "all")
  assert.deepEqual(selectConfigurationSection(settings, undefined), settings)
  assert.equal(selectConfigurationSection(settings, "missing.path"), null)
  assert.equal(selectConfigurationSection(undefined, "x"), null)
})

test("start() pushes the initial settings via workspace/didChangeConfiguration", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const settings = { "rust-analyzer": { cargo: { features: "all" } } }
  const client = makeClient(mock, { settings })
  await client.start()

  const change = mock
    .inspect()
    .sentNotifications.find((n) => n.method === "workspace/didChangeConfiguration")
  assert.ok(change, "didChangeConfiguration should be pushed on start")
  assert.deepEqual(change.params.settings, settings)

  await client.stop()
})

test("workspace/configuration pull is answered from per-server settings", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const settings = { "rust-analyzer": { cargo: { features: "all" } } }
  const client = makeClient(mock, { settings })
  await client.start()

  const reply = mock.simulateRequest("workspace/configuration", {
    items: [{ section: "rust-analyzer.cargo" }, { section: "nope" }, {}],
  })
  assert.deepEqual(reply, [{ features: "all" }, null, settings])

  await client.stop()
})

test("no settings → no didChangeConfiguration push, and pulls return null", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  const change = mock
    .inspect()
    .sentNotifications.find((n) => n.method === "workspace/didChangeConfiguration")
  assert.equal(change, undefined)
  const reply = mock.simulateRequest("workspace/configuration", { items: [{ section: "x" }] })
  assert.deepEqual(reply, [null])

  await client.stop()
})

test("updateConfiguration pushes a new didChangeConfiguration when running", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  await client.start()
  client.updateConfiguration({ foo: { bar: 1 } })

  const changes = mock
    .inspect()
    .sentNotifications.filter((n) => n.method === "workspace/didChangeConfiguration")
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0].params.settings, { foo: { bar: 1 } })
  // The new settings are now visible to a pull.
  assert.deepEqual(
    mock.simulateRequest("workspace/configuration", { items: [{ section: "foo.bar" }] }),
    [1]
  )

  await client.stop()
})

test("startupTimeout: a hung initialize rejects start() and flips to crashed", async () => {
  const mock = makeMockConnection()
  // initialize never resolves — simulate a hung binary.
  mock.replyTo("initialize", () => new Promise(() => {}))

  const client = makeClient(mock, { startupTimeout: 30 })
  const states = []
  client.onStateChange((s) => states.push(s))

  await assert.rejects(() => client.start(), /initialize timed out after 30ms/)
  assert.equal(client.getState(), "crashed")
  assert.deepEqual(states, ["starting", "crashed"])
})

test("onStateChange + onLog fire through the normal lifecycle", async () => {
  const mock = makeMockConnection()
  mock.replyTo("initialize", () => ({ capabilities: ECHO_CAPS }))
  mock.replyTo("shutdown", () => null)

  const client = makeClient(mock)
  const states = []
  const logs = []
  const offState = client.onStateChange((s) => states.push(s))
  client.onLog((e) => logs.push(e))

  await client.start()
  assert.deepEqual(states, ["starting", "running"])
  assert.ok(logs.some((e) => e.level === "info" && e.message === "initialized"))
  assert.equal(client.getDocumentVersion("file:///nope.ts"), null)

  client.registerTextDocument("file:///a.ts", "typescript", "let a = 1")
  client.changeTextDocument("file:///a.ts", "let a = 2")
  assert.equal(client.getDocumentVersion("file:///a.ts"), 2)

  offState()
  await client.stop()
  assert.deepEqual(states, ["starting", "running"], "unsubscribed listener stays quiet")
})

test("sandbox LSP clients do not re-inherit the parent environment", async () => {
  const saved = process.env.COGNIA_LSP_ENV_TEST
  process.env.COGNIA_LSP_ENV_TEST = "ambient-secret"
  const script = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(buffer.slice(0,end))[1]);if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.slice(end+4,end+4+length));buffer=buffer.slice(end+4+length);if(message.method==='exit')process.exit(0);if(message.id!==undefined){const result=message.method==='initialize'?{capabilities:{experimental:{ambient:process.env.COGNIA_LSP_ENV_TEST??null}}}:null;const text=JSON.stringify({jsonrpc:'2.0',id:message.id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(text)+'\\r\\n\\r\\n'+text)}}})`
  const client = new CogniaLspClient({
    serverId: "env-test",
    command: process.execPath,
    args: ["-e", script],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "" },
    startupTimeout: 1000,
  })
  try {
    await client.start()
    assert.equal(client.getServerCapabilities().experimental.ambient, null)
  } finally {
    await client.stop()
    if (saved === undefined) delete process.env.COGNIA_LSP_ENV_TEST
    else process.env.COGNIA_LSP_ENV_TEST = saved
  }
})
