import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { PROVIDER_ADAPTER_KINDS, registerManagedProviders } from "../src/provider-adapters.mjs"

const catalog = JSON.parse(
  await readFile(
    new URL("../../../packages/plugin-sdk/contract/code-1.128-ide.json", import.meta.url)
  )
)

test("every stable Code 1.128 provider family has an adapter", () => {
  assert.deepEqual(
    [...PROVIDER_ADAPTER_KINDS].sort(),
    catalog.providers.map((entry) => entry.kind).sort()
  )
})

test("command provider invokes Cognia runtime and unregisters transactionally", async () => {
  const calls = []
  let registered
  let disposed = false
  const vscode = {
    commands: {
      registerCommand(id, handler) {
        registered = { id, handler }
        return { dispose: () => (disposed = true) }
      },
    },
  }
  const registration = await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.refresh",
        kind: "command",
        handler: "refresh",
      },
    ]),
    {
      invoke: async (provider, operation, args) => {
        calls.push({ provider, operation, args })
        return { refreshed: true }
      },
    }
  )

  assert.equal(registered.id, "cognia.acme.tools.refresh")
  assert.deepEqual(await registered.handler("all"), { refreshed: true })
  assert.equal(calls[0].provider.handler, "refresh")
  assert.equal(calls[0].operation, "execute")
  registration.dispose()
  assert.equal(disposed, true)
})

test("registration rejects undeclared provider families without a silent no-op", async () => {
  await assert.rejects(
    registerManagedProviders(
      {},
      descriptor([
        {
          id: "cognia.acme.tools.future",
          kind: "future-provider",
          handler: "future",
        },
      ]),
      { invoke: async () => null }
    ),
    /IDE_PROVIDER_UNCLASSIFIED/
  )
})

test("a failed activation transaction disposes providers already registered", async () => {
  let disposed = false
  const vscode = {
    commands: {
      registerCommand() {
        return { dispose: () => (disposed = true) }
      },
    },
  }
  await assert.rejects(
    registerManagedProviders(
      vscode,
      descriptor([
        {
          id: "cognia.acme.tools.refresh",
          kind: "command",
          handler: "refresh",
        },
        {
          id: "cognia.acme.tools.hover",
          kind: "hover",
          handler: "hover",
        },
      ]),
      { invoke: async () => null }
    ),
    /IDE_CODE_API_UNAVAILABLE/
  )
  assert.equal(disposed, true)
})

test("file-system provider transfers binary values through scoped content handles", async () => {
  let fileSystem
  const vscode = {
    EventEmitter: class {
      event = () => undefined
      fire() {}
      dispose() {}
    },
    Disposable: {
      from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
    },
    workspace: {
      registerFileSystemProvider(_scheme, provider) {
        fileSystem = provider
        return { dispose() {} }
      },
    },
  }
  const inputHandle = {
    $type: "ContentHandle",
    id: "input",
    size: 3,
    sha256: "a".repeat(64),
  }
  const outputHandle = {
    $type: "ContentHandle",
    id: "output",
    size: 2,
    sha256: "b".repeat(64),
  }
  const calls = []
  await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.fs",
        kind: "file-system",
        handler: "fs",
        permission: "filesystem:write",
        metadata: { scheme: "cognia.acme.tools.fs" },
      },
    ]),
    {
      createContent: async (_provider, bytes) => {
        assert.deepEqual(bytes, Uint8Array.from([1, 2, 3]))
        return inputHandle
      },
      readContent: async (_provider, handle) => {
        assert.equal(handle, outputHandle)
        return Uint8Array.from([4, 5])
      },
      invoke: async (_provider, operation, args) => {
        calls.push({ operation, args })
        return operation === "readFile" ? outputHandle : undefined
      },
    }
  )

  await fileSystem.writeFile({ scheme: "file", path: "/work/a" }, Uint8Array.from([1, 2, 3]))
  assert.equal(calls[0].args[1], inputHandle)
  assert.deepEqual(
    await fileSystem.readFile({ scheme: "file", path: "/work/a" }),
    Uint8Array.from([4, 5])
  )
})

test("stable drop and paste providers serialize data transfers and apply prepared clipboard data", async () => {
  let dropProvider
  let pasteProvider
  const calls = []
  class DataTransferItem {
    constructor(value) {
      this.value = value
    }
    async asString() {
      return String(this.value)
    }
    asFile() {
      return undefined
    }
  }
  const vscode = {
    DataTransferItem,
    languages: {
      registerDocumentDropEditProvider(_selector, provider) {
        dropProvider = provider
        return { dispose() {} }
      },
      registerDocumentPasteEditProvider(_selector, provider) {
        pasteProvider = provider
        return { dispose() {} }
      },
    },
  }
  const broker = {
    invoke: async (provider, operation, args) => {
      calls.push({ provider: provider.kind, operation, args })
      return operation === "prepare"
        ? { items: [{ mimeType: "application/x-acme", value: "prepared" }] }
        : []
    },
  }
  await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.drop",
        kind: "document-drop-edit",
        handler: "drop",
      },
      {
        id: "cognia.acme.tools.paste",
        kind: "document-paste-edit",
        handler: "paste",
      },
    ]),
    broker
  )
  const transfer = new Map([["text/plain", new DataTransferItem("copied")]])
  await dropProvider.provideDocumentDropEdits({}, {}, transfer, {})
  assert.deepEqual(calls[0].args[2], {
    $type: "DataTransfer",
    items: [{ mimeType: "text/plain", kind: "string", value: "copied" }],
  })

  await pasteProvider.prepareDocumentPaste({}, [], transfer, {})
  assert.equal(transfer.get("application/x-acme").value, "prepared")
})

test("file decorations, language status and serialized webviews use native stable surfaces", async () => {
  let fileDecoration
  let languageStatus
  let serializer
  const listeners = []
  const vscode = {
    EventEmitter: class {
      event = () => undefined
      fire() {}
      dispose() {}
    },
    Disposable: {
      from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
    },
    languages: {
      createLanguageStatusItem() {
        languageStatus = { dispose() {} }
        return languageStatus
      },
    },
    window: {
      registerFileDecorationProvider(provider) {
        fileDecoration = provider
        return { dispose() {} }
      },
      registerWebviewPanelSerializer(_viewType, value) {
        serializer = value
        return { dispose() {} }
      },
    },
  }
  const broker = {
    onEvent(listener) {
      listeners.push(listener)
      return { dispose() {} }
    },
    invoke: async (_provider, operation) => {
      if (operation === "initialize") return { text: "Ready", busy: false }
      if (operation === "deserialize") {
        return {
          html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`,
        }
      }
      return { badge: "A", tooltip: "Managed" }
    },
  }
  await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.files",
        kind: "file-decoration",
        handler: "files",
      },
      {
        id: "cognia.acme.tools.language",
        kind: "language-status-item",
        handler: "language",
      },
      {
        id: "cognia.acme.tools.panel",
        kind: "webview-panel-serializer",
        handler: "panel",
        metadata: { viewType: "cognia.acme.tools.panel" },
      },
    ]),
    broker
  )
  assert.deepEqual(await fileDecoration.provideFileDecoration({}, {}), {
    badge: "A",
    tooltip: "Managed",
  })
  assert.equal(languageStatus.text, "Ready")
  assert.equal(languageStatus.busy, false)

  const panel = {
    webview: {
      onDidReceiveMessage() {
        return { dispose() {} }
      },
    },
  }
  await serializer.deserializeWebviewPanel(panel, { page: 1 })
  assert.match(panel.webview.html, /default-src 'none'/)
  assert.deepEqual(panel.webview.options, {
    enableScripts: false,
    localResourceRoots: [],
  })
  assert.equal(listeners.length, 2)
})

test("status items are host-rendered and updated only through broker events", async () => {
  let statusItem
  let onEvent
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    Disposable: {
      from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
    },
    window: {
      createStatusBarItem(id, alignment, priority) {
        statusItem = {
          id,
          alignment,
          priority,
          visible: false,
          show() {
            this.visible = true
          },
          hide() {
            this.visible = false
          },
          dispose() {},
        }
        return statusItem
      },
    },
  }
  const registration = await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.health",
        kind: "status-bar-item",
        handler: "status",
        metadata: { alignment: "right", priority: 10 },
      },
    ]),
    {
      invoke: async () => ({ text: "Ready", visible: true }),
      onEvent: (listener) => {
        onEvent = listener
        return { dispose() {} }
      },
    }
  )
  assert.equal(statusItem.id, "cognia.acme.tools.health")
  assert.equal(statusItem.alignment, 2)
  assert.equal(statusItem.text, "Ready")
  assert.equal(statusItem.visible, true)
  onEvent({
    providerId: "cognia.acme.tools.health",
    event: "change",
    payload: { text: "Offline", visible: false },
  })
  assert.equal(statusItem.text, "Offline")
  assert.equal(statusItem.visible, false)
  registration.dispose()
})

test("chat participants project live agent stream, approval and cancellation surfaces", async () => {
  let handler
  let listener
  let resolveInvocation
  const streamed = []
  const approvals = []
  const invocation = new Promise((resolve) => {
    resolveInvocation = resolve
  })
  const vscode = {
    chat: {
      createChatParticipant(_id, value) {
        handler = value
        return { dispose() {} }
      },
    },
    l10n: { t: (value, ...args) => value.replace("{0}", args[0] ?? "") },
    window: {
      showWarningMessage: async (...args) => {
        approvals.push(args)
        return "Allow"
      },
    },
  }
  const broker = {
    createInvocationId: () => "chat-invocation",
    onEvent(value) {
      listener = value
      return { dispose() {} }
    },
    invoke: async () => invocation,
    respondApproval: (...args) => approvals.push(args),
  }
  await registerManagedProviders(
    vscode,
    descriptor([
      {
        id: "cognia.acme.tools.assistant",
        kind: "chat-participant",
        handler: "$agent:researcher",
      },
    ]),
    broker
  )

  const pending = handler(
    { prompt: "inspect" },
    {},
    {
      markdown: (value) => streamed.push(["markdown", value]),
      progress: (value) => streamed.push(["progress", value]),
    },
    { onCancellationRequested() {} }
  )
  await new Promise((resolve) => setImmediate(resolve))
  listener({
    providerId: "cognia.acme.tools.assistant",
    invocationId: "chat-invocation",
    event: "stream",
    payload: { type: "text-delta", delta: "live" },
  })
  listener({
    providerId: "cognia.acme.tools.assistant",
    invocationId: "chat-invocation",
    event: "approval",
    payload: {
      requestId: "approval-1",
      toolName: "Bash",
      input: { command: "pwd" },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(streamed, [["markdown", "live"]])
  assert.match(approvals[0][0], /Bash/)
  assert.deepEqual(approvals[1], [
    {
      id: "cognia.acme.tools.assistant",
      kind: "chat-participant",
      handler: "$agent:researcher",
    },
    "chat-invocation",
    "approval-1",
    "allow",
    undefined,
    undefined,
  ])

  resolveInvocation({ result: { metadata: { runId: "run-1" } } })
  assert.deepEqual(await pending, { metadata: { runId: "run-1" } })
})

function descriptor(providers) {
  return {
    pluginId: "acme.tools",
    pluginVersion: "1.0.0",
    manifestHash: "sha256:manifest",
    catalogHash: "sha256:catalog",
    providers,
  }
}
