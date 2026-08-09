// Cognia Agent Bridge — a VS Code extension side-loaded into the embedded
// code-server (Pro IDE Phase 2). It dials the app's loopback agent channel and
// lets the Cognia agent drive the live editor: open/reveal a file, reflect an
// on-disk write as an undo-able edit, and read the active-editor context back.
//
// Dormant unless launched by Cognia: `activate` returns immediately when the
// `COGNIA_CS_AGENT_PORT` / `COGNIA_CS_AGENT_TOKEN` env vars are absent, so the
// extension is inert in any other code-server.

import * as net from "node:net"
import { createHmac, randomUUID } from "node:crypto"
import * as vscode from "vscode"
import { ContentHandleClient } from "./content-handles.mjs"
import { findOccupiedContributionIds } from "./contribution-ids.mjs"
import {
  ContentLengthDecoder,
  brokerChallengeRequest,
  brokerHelloRequest,
  errorResponse,
  eventNotification,
  responseMessage,
  serializeContentLength,
  validateNegotiatedHello,
} from "./jsonrpc.mjs"
import {
  diagnosticSeverityName,
  editReflectionAction,
  eventFrame,
  helloFrame,
  notificationKind,
  parseRequest,
  responseFrame,
  splitFrames,
  toZeroBased,
} from "./protocol.mjs"

/** Delay before retrying a dropped connection to the app's agent channel. */
const RECONNECT_DELAY_MS = 1000

/**
 * How long editor-change events are coalesced before being pushed.
 *
 * Selection changes fire per keystroke and per cursor move; forwarding each one
 * would turn a held arrow key into hundreds of socket writes and app-side
 * re-reads. The app only ever responds by re-reading the current state, so
 * collapsing a burst into one trailing event loses nothing.
 */
const EVENT_COALESCE_MS = 150
const BROKER_REQUEST_TIMEOUT_MS = 30_000
const IDE_CATALOG_HASH = "sha256:53cf23036ed2e14693f284778d7f2b0cd7cd5802ee63bb42c573063f40f86fb3"

/**
 * Owns the single TCP connection back to the app and dispatches inbound request
 * frames to the editor handlers. Reconnects with a fixed backoff so a transient
 * app-side restart doesn't leave the bridge dead.
 */
class AgentBridge {
  constructor(port, token, protocolMode) {
    this.port = port
    this.token = token
    this.protocolMode = protocolMode
    this.socket = null
    this.buffer = ""
    this.decoder = new ContentLengthDecoder()
    this.disposed = false
    this.reconnectTimer = null
    this.coalesceTimers = new Map()
    this.inflight = new Map()
    this.pending = new Map()
    this.notificationListeners = new Set()
    this.nextRequestId = 1
    this.negotiated = null
  }

  start() {
    this.connect()
  }

  dispose() {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const timer of this.coalesceTimers.values()) clearTimeout(timer)
    this.coalesceTimers.clear()
    this.failPending("Managed IDE broker disposed")
    this.notificationListeners.clear()
    this.socket?.destroy()
    this.socket = null
  }

  /**
   * Push an event to the app, coalescing repeats of the same `name` inside
   * {@link EVENT_COALESCE_MS}. Dropped silently when the socket is down — an event
   * describes current state, so the next one supersedes anything missed and there
   * is nothing worth queueing across a reconnect.
   */
  emit(name, payloadFn) {
    if (this.disposed) return
    const existing = this.coalesceTimers.get(name)
    if (existing) clearTimeout(existing)
    this.coalesceTimers.set(
      name,
      setTimeout(() => {
        this.coalesceTimers.delete(name)
        if (this.disposed || !this.socket) return
        try {
          this.writeEvent(name, payloadFn())
        } catch {
          // Socket died between the check and the write; the reconnect handles it.
        }
      }, EVENT_COALESCE_MS)
    )
  }

  connect() {
    if (this.disposed) return
    const socket = net.createConnection({ host: "127.0.0.1", port: this.port }, () => {
      this.buffer = ""
      this.decoder = new ContentLengthDecoder()
      this.negotiated = null
      if (this.protocolMode === "jsonrpc") {
        const credential = splitBrokerCredential(this.token)
        if (!credential) {
          socket.destroy()
          return
        }
        this.credential = credential
        socket.write(serializeContentLength(brokerChallengeRequest(credential.tokenId)))
      } else {
        socket.write(helloFrame(this.token))
      }
    })
    if (this.protocolMode === "legacy") socket.setEncoding("utf8")
    socket.on("data", (chunk) => this.onData(chunk))
    // Errors surface as a `close`; swallow so an unhandled 'error' can't crash
    // the extension host.
    socket.on("error", () => {})
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null
      this.failPending("Managed IDE broker disconnected")
      this.scheduleReconnect()
    })
    this.socket = socket
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY_MS)
  }

  onData(chunk) {
    if (this.protocolMode === "jsonrpc") {
      let messages
      try {
        messages = this.decoder.push(chunk)
      } catch {
        this.socket?.destroy()
        return
      }
      for (const message of messages) void this.handleJsonRpc(message)
      return
    }
    const { lines, rest } = splitFrames(this.buffer + chunk)
    this.buffer = rest
    for (const line of lines) void this.handleLine(line)
  }

  async handleLine(line) {
    const req = parseRequest(line)
    if (!req) return
    try {
      const result = await dispatch(req.method, req.params)
      this.socket?.write(responseFrame(req.id, { ok: true, result }))
    } catch (error) {
      this.socket?.write(
        responseFrame(req.id, { ok: false, error: String(error?.message ?? error) })
      )
    }
  }

  writeEvent(name, payload) {
    if (!this.socket) return
    if (this.protocolMode === "jsonrpc") {
      this.socket.write(serializeContentLength(eventNotification(name, payload)))
    } else {
      this.socket.write(eventFrame(name, payload))
    }
  }

  request(method, params, options = {}) {
    if (this.protocolMode !== "jsonrpc") {
      return Promise.reject(new Error("LEGACY_CAPABILITY_UNSUPPORTED: provider callbacks"))
    }
    if (!this.socket || !this.negotiated) {
      return Promise.reject(new Error("Managed IDE broker is not ready"))
    }
    const id = `proxy:${this.nextRequestId++}`
    const timeoutMs = options.timeoutMs ?? BROKER_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify("$/cancelRequest", { id })
        reject(new Error(`Managed IDE broker request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.write(
          serializeContentLength({
            jsonrpc: "2.0",
            id,
            method,
            params,
          })
        )
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    if (this.protocolMode !== "jsonrpc" || !this.socket) return
    this.socket.write(serializeContentLength({ jsonrpc: "2.0", method, params }))
  }

  onNotification(listener) {
    this.notificationListeners.add(listener)
    return {
      dispose: () => this.notificationListeners.delete(listener),
    }
  }

  failPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  async handleJsonRpc(message) {
    if (!message || message.jsonrpc !== "2.0") return
    if (message.id === "challenge" && ("result" in message || "error" in message)) {
      if (message.error || typeof message.result?.challenge !== "string" || !this.credential) {
        this.socket?.destroy()
        return
      }
      const proof = createHmac("sha256", this.credential.secret)
        .update(message.result.challenge)
        .digest("hex")
      this.socket?.write(
        serializeContentLength(
          brokerHelloRequest({
            tokenId: this.credential.tokenId,
            proof,
            catalogHash: process.env.COGNIA_CS_CATALOG_HASH ?? IDE_CATALOG_HASH,
            hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
            workspace: process.env.COGNIA_CS_WORKSPACE ?? "",
          })
        )
      )
      return
    }
    if (message.id === "hello" && ("result" in message || "error" in message)) {
      if (message.error) {
        this.socket?.destroy()
      } else {
        try {
          this.negotiated = validateNegotiatedHello(
            message.result,
            process.env.COGNIA_CS_CATALOG_HASH ?? IDE_CATALOG_HASH
          )
        } catch {
          this.socket?.destroy()
        }
      }
      return
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message ?? "Managed IDE broker request failed")
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === "$/cancelRequest") {
      const id = message.params?.id
      this.inflight.get(id)?.abort()
      return
    }
    if (message.method === "cognia/provider/event" && message.id === undefined) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message.params ?? {})
        } catch {
          // One proxy's event handler cannot break delivery to other proxies.
        }
      }
      return
    }
    if (typeof message.method !== "string" || message.id === undefined) return

    const controller = new AbortController()
    this.inflight.set(message.id, controller)
    try {
      const result = await dispatch(message.method, message.params ?? {}, controller.signal)
      if (controller.signal.aborted) {
        this.socket?.write(
          serializeContentLength(errorResponse(message.id, -32800, "Request cancelled"))
        )
      } else {
        this.socket?.write(serializeContentLength(responseMessage(message.id, result)))
      }
    } catch (error) {
      const methodMissing = String(error?.message ?? error).startsWith("unknown method:")
      this.socket?.write(
        serializeContentLength(
          errorResponse(
            message.id,
            methodMissing ? -32601 : -32603,
            String(error?.message ?? error)
          )
        )
      )
    } finally {
      this.inflight.delete(message.id)
    }
  }
}

function splitBrokerCredential(value) {
  const separator = value.indexOf(".")
  if (separator <= 0 || separator === value.length - 1) return null
  return {
    tokenId: value.slice(0, separator),
    secret: value.slice(separator + 1),
  }
}

/** Route a request method to its editor handler. */
async function dispatch(method, params, signal) {
  if (signal?.aborted) throw new Error("Request cancelled")
  switch (method) {
    case "openFile":
      return openFile(params)
    case "applyEdit":
      return applyEdit(params)
    case "readActive":
      return readActive()
    case "saveAll":
      return saveAll(params)
    case "showDiff":
      return showDiff(params)
    case "revealInExplorer":
      return revealInExplorer(params)
    case "runInTerminal":
      return runInTerminal(params)
    case "notify":
      return notify(params)
    case "managedProxyHandshake":
      return managedProxyHandshake(params)
    case "restartManagedExtensionHost":
      await vscode.commands.executeCommand("workbench.action.restartExtensionHost")
      return null
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

async function managedProxyHandshake(params) {
  const pluginId = String(params?.pluginId ?? "")
  const extensionName = `proxy-${pluginId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")}`
  const extension = vscode.extensions.getExtension(`cognia-managed.${extensionName}`)
  if (!extension) throw new Error(`IDE_PROXY_EXTENSION_NOT_DISCOVERED: ${pluginId}`)
  if (!extension.isActive) await extension.activate()
  const registration = proxyRegistrations.get(pluginId)
  const descriptor = extension.packageJSON?.cogniaManaged
  if (!registration || !descriptor) {
    throw new Error(`IDE_PROXY_ACTIVATION_INCOMPLETE: ${pluginId}`)
  }
  for (const [field, expected] of [
    ["pluginVersion", params.pluginVersion],
    ["manifestHash", params.manifestHash],
    ["catalogHash", params.catalogHash],
    ["platformVersion", params.platformVersion],
  ]) {
    if (descriptor[field] !== expected) {
      throw new Error(`IDE_PROXY_HANDSHAKE_MISMATCH: ${field}`)
    }
  }
  return {
    pluginId,
    pluginVersion: descriptor.pluginVersion,
    manifestHash: descriptor.manifestHash,
    catalogHash: descriptor.catalogHash,
    platformVersion: descriptor.platformVersion,
    providerCount: descriptor.providers?.length ?? 0,
    protocolCount: ["lsp", "dap", "mcp"].reduce(
      (count, family) => count + (descriptor.protocols?.[family]?.length ?? 0),
      0
    ),
  }
}

/**
 * Flush dirty editor buffers to disk.
 *
 * Closes a real correctness hole rather than adding a convenience: the agent's file
 * tools read and write the filesystem directly, so any buffer the user has edited
 * but not saved is invisible to them. Before this, an agent asked to "fix the bug in
 * this file" would read the *stale* on-disk copy, reason about code the user had
 * already changed, and then overwrite their unsaved work.
 *
 * Scoped to `path` when given, otherwise every dirty file editor. Untitled
 * documents are skipped — they have no path for the agent to read, and saving one
 * would pop a modal file dialog in the middle of an agent turn.
 */
async function saveAll(params = {}) {
  const only = params.path ? String(params.path) : null
  const dirty = vscode.workspace.textDocuments.filter(
    (doc) =>
      doc.isDirty &&
      !doc.isUntitled &&
      doc.uri.scheme === "file" &&
      (only === null || doc.uri.fsPath === only)
  )
  const saved = []
  const failed = []
  for (const doc of dirty) {
    try {
      if (await doc.save()) saved.push(doc.uri.fsPath)
      else failed.push(doc.uri.fsPath)
    } catch {
      failed.push(doc.uri.fsPath)
    }
  }
  // Reported rather than thrown: a partial flush is still progress, and the caller
  // needs to know *which* files it cannot trust the disk copy of.
  return { saved, failed }
}

/**
 * Open VS Code's native diff editor between the file on disk and a proposed
 * revision, so an agent change can be reviewed before it lands.
 *
 * The proposal rides in as `content` and is materialised through an in-memory
 * document (`cognia-proposed:` scheme, registered on activate) — never a temp file
 * on disk, which would show up in the project tree, in git status, and in the
 * agent's own next file read.
 */
async function showDiff(params) {
  const path = String(params.path ?? "")
  if (!path) throw new Error("showDiff requires a path")
  if (typeof params.content !== "string") throw new Error("showDiff requires content")
  const left = vscode.Uri.file(path)
  const right = proposedUri(left)
  proposedContents.set(right.toString(), params.content)
  proposedEmitter.fire(right)
  const title = params.title ? String(params.title) : `${basename(path)} — proposed`
  await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true })
  return { shown: true, path }
}

/** Reveal a path in the file explorer and focus its tree item. */
async function revealInExplorer(params) {
  const path = String(params.path ?? "")
  if (!path) throw new Error("revealInExplorer requires a path")
  await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path))
  return { revealed: true, path }
}

/**
 * Run a command in a VS Code integrated terminal, reusing the one named for the
 * app so repeated calls share history instead of spawning a terminal each time.
 *
 * `sendText` only — the extension host cannot read a terminal's output back, so
 * this is explicitly "show the user this command running", not a way for the agent
 * to collect output. The agent has its own shell tool for that.
 */
async function runInTerminal(params) {
  const command = String(params.command ?? "")
  if (!command) throw new Error("runInTerminal requires a command")
  const name = params.name ? String(params.name) : "Cognia"
  const existing = vscode.window.terminals.find((t) => t.name === name && t.exitStatus == null)
  const terminal =
    existing ??
    vscode.window.createTerminal({
      name,
      cwd: params.cwd ? String(params.cwd) : undefined,
    })
  terminal.show(true)
  terminal.sendText(command, params.execute !== false)
  return { sent: true, terminal: name }
}

/** Surface an app-side message inside the editor. */
async function notify(params) {
  const message = String(params.message ?? "")
  if (!message) throw new Error("notify requires a message")
  const kind = notificationKind(params.kind)
  const show =
    kind === "error"
      ? vscode.window.showErrorMessage
      : kind === "warning"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage
  // Deliberately not awaited: `showInformationMessage` resolves only when the
  // notification is dismissed, which would hold the request open past its timeout.
  void show.call(vscode.window, message)
  return { shown: true, kind }
}

function basename(path) {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * Snapshot the live active-editor context for the agent: the focused file, the
 * selection (1-based), the selected text, that file's diagnostics, and the list
 * of open file editors. Whole-file bodies are deliberately excluded — the agent
 * reads files with its own tools; this is about "what is the user looking at".
 * The app PII-gates this payload before it reaches the model.
 */
async function readActive() {
  const openEditors = vscode.workspace.textDocuments
    .filter((doc) => doc.uri.scheme === "file")
    .map((doc) => doc.uri.fsPath)

  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file") {
    return { path: null, selection: null, selectedText: null, diagnostics: [], openEditors }
  }

  const doc = editor.document
  const sel = editor.selection
  const selection = {
    startLine: sel.start.line + 1,
    startColumn: sel.start.character + 1,
    endLine: sel.end.line + 1,
    endColumn: sel.end.character + 1,
  }
  const selectedText = sel.isEmpty ? null : doc.getText(sel)
  const diagnostics = vscode.languages.getDiagnostics(doc.uri).map((d) => ({
    message: d.message,
    severity: diagnosticSeverityName(d.severity),
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
  }))

  return { path: doc.uri.fsPath, selection, selectedText, diagnostics, openEditors }
}

/** Open + reveal an absolute path, optionally scrolling to a 1-based line/column. */
async function revealFile(path, line, column) {
  const l = toZeroBased(line)
  const c = toZeroBased(column) ?? 0
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
  const selection = l != null ? new vscode.Range(l, c, l, c) : undefined
  const editor = await vscode.window.showTextDocument(doc, { preview: false, selection })
  if (selection) {
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
  return doc
}

async function openFile(params) {
  const path = String(params.path ?? "")
  if (!path) throw new Error("openFile requires a path")
  await revealFile(path, params.line, params.column)
  return { opened: true, path }
}

/**
 * Reflect an agent's on-disk write as an undo-able edit. Disk is the source of
 * truth (the agent already wrote it); if the file is open with a stale buffer we
 * replace it via a WorkspaceEdit so the change enters VS Code's undo stack, then
 * save to clear the dirty flag (otherwise the file-watcher's later reload would
 * pop a "changed on disk" conflict). Closed or already-reconciled files just get
 * revealed — there is nothing to make undo-able.
 */
async function applyEdit(params) {
  const path = String(params.path ?? "")
  if (!path) throw new Error("applyEdit requires a path")
  const uri = vscode.Uri.file(path)

  let diskText
  try {
    diskText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8")
  } catch {
    // File gone / unreadable — nothing to reflect; the caller degrades.
    return { reflected: false, opened: false, path }
  }

  const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath)
  const reflectionAction = editReflectionAction(
    diskText,
    openDoc?.getText() ?? null,
    openDoc?.isDirty === true
  )
  if (reflectionAction === "conflict") {
    throw new Error(
      "DIRTY_DOCUMENT_CONFLICT: the editor has unsaved changes; resolve them before applying the agent edit"
    )
  }
  let reflected = false
  if (openDoc && reflectionAction === "reflect") {
    const current = openDoc.getText()
    const fullRange = new vscode.Range(openDoc.positionAt(0), openDoc.positionAt(current.length))
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, fullRange, diskText)
    reflected = await vscode.workspace.applyEdit(edit)
    if (reflected) {
      try {
        await openDoc.save()
      } catch {
        // Best-effort; the change is already on disk.
      }
    }
  }

  await revealFile(path, params.line, params.column)
  return { reflected, opened: true, path }
}

/**
 * In-memory store backing the `showDiff` right-hand side.
 *
 * A `TextDocumentContentProvider` rather than a temp file: a proposal written to
 * disk would appear in the project tree, in `git status`, and — worst — in the
 * agent's own next directory listing, which is exactly the confusion a pre-flight
 * review is supposed to prevent.
 */
const PROPOSED_SCHEME = "cognia-proposed"
const proposedContents = new Map()
let proposedEmitter = null

function proposedUri(fileUri) {
  return fileUri.with({ scheme: PROPOSED_SCHEME })
}

/** Maximum snapshot size for chat context to avoid blowing up the chat store. */
const MAX_CHAT_SNAPSHOT_CHARS = 20_000

/**
 * Capture the current editor context for a chat action. Returns null when
 * there is nothing actionable (no active file-based editor).
 */
function captureChatContext(action) {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file") return null

  const doc = editor.document
  const sel = editor.selection
  const hasSelection = !sel.isEmpty

  let selectedText = hasSelection ? doc.getText(sel) : null
  let truncated = false
  if (selectedText && selectedText.length > MAX_CHAT_SNAPSHOT_CHARS) {
    selectedText = selectedText.slice(0, MAX_CHAT_SNAPSHOT_CHARS)
    truncated = true
  }

  return {
    action,
    path: doc.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(doc.uri, false),
    language: doc.languageId,
    selection: hasSelection
      ? {
          startLine: sel.start.line + 1,
          startColumn: sel.start.character + 1,
          endLine: sel.end.line + 1,
          endColumn: sel.end.character + 1,
        }
      : null,
    selectedText,
    truncated,
    diagnostics: hasSelection
      ? vscode.languages
          .getDiagnostics(doc.uri)
          .filter((d) => sel.contains(d.range) || sel.intersection(d.range))
          .map((d) => ({
            message: d.message,
            severity: diagnosticSeverityName(d.severity),
            line: d.range.start.line + 1,
          }))
      : [],
  }
}

/**
 * Capture file-level context (no selection required). Used by "Add File to
 * Context" from the explorer context menu.
 */
function captureFileContext(uri) {
  if (!uri || uri.scheme !== "file") return null
  return {
    action: "addFile",
    path: uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(uri, false),
    language: null,
    selection: null,
    selectedText: null,
    truncated: false,
    diagnostics: [],
  }
}

let bridge = null
let contentHandles = null
const proxyRegistrations = new Map()

async function registerProxy(context, descriptor) {
  if (!bridge) throw new Error("Managed IDE broker is not active")
  if (descriptor.platformVersion !== "1.0.0") {
    throw new Error("IDE_PLATFORM_VERSION_MISMATCH")
  }
  if (descriptor.catalogHash !== IDE_CATALOG_HASH) {
    throw new Error("IDE_CATALOG_MISMATCH")
  }
  const runtimeDescriptor = {
    ...descriptor,
    contributions: context.extension.packageJSON?.contributes ?? {},
  }
  const collisions = findOccupiedContributionIds(vscode, runtimeDescriptor, context.extension.id)
  if (collisions.length > 0) {
    throw new Error(
      `IDE_CONTRIBUTION_ID_OCCUPIED: ${collisions
        .map((entry) => `${entry.kind}:${entry.id}@${entry.extensionId}`)
        .join(", ")}`
    )
  }
  const { createManagedStorageFacade } = await import("./managed-storage.mjs")
  const managedStorage = await createManagedStorageFacade({
    request: (method, params) => bridge.request(method, params),
    descriptor: runtimeDescriptor,
    hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
    workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
    getWorkspaceTrusted: () => vscode.workspace.isTrusted,
  })
  const { registerManagedProviders } = await import("./provider-adapters.mjs")
  let providerRegistration
  try {
    providerRegistration = await registerManagedProviders(vscode, runtimeDescriptor, {
      managedStorage,
      onEvent: (listener) =>
        bridge.onNotification((message) => {
          if (message?.pluginId === runtimeDescriptor.pluginId) listener(message)
        }),
      createInvocationId: () => randomUUID(),
      invoke: (provider, operation, args, token, suppliedInvocationId) => {
        const invocationId = suppliedInvocationId ?? randomUUID()
        const request = bridge.request("cognia/provider/invoke", {
          invocationId,
          pluginId: runtimeDescriptor.pluginId,
          pluginVersion: runtimeDescriptor.pluginVersion,
          manifestHash: runtimeDescriptor.manifestHash,
          catalogHash: runtimeDescriptor.catalogHash,
          hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
          workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
          workspaceTrusted: vscode.workspace.isTrusted,
          providerId: provider.id,
          providerKind: provider.kind,
          handler: provider.handler,
          permission: provider.permission ?? null,
          operation,
          arguments: args,
        })
        token?.onCancellationRequested(() => {
          // The request owns its JSON-RPC cancellation id internally; cancellation
          // is also carried as a provider operation so the host can stop work even
          // when the callback arrived before the pending id was observable here.
          bridge?.notify("cognia/provider/cancel", {
            invocationId,
            pluginId: runtimeDescriptor.pluginId,
            providerId: provider.id,
            operation,
          })
        })
        return request
      },
      respondApproval: (provider, invocationId, requestId, decision, updatedInput, message) => {
        bridge.notify("cognia/provider/approvalResponse", {
          invocationId,
          requestId,
          pluginId: runtimeDescriptor.pluginId,
          providerId: provider.id,
          decision,
          ...(updatedInput ? { updatedInput } : {}),
          ...(message ? { message } : {}),
        })
      },
      createContent: (provider, bytes) => {
        if (!contentHandles) throw new Error("IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE")
        return contentHandles.upload({ ...provider, pluginId: runtimeDescriptor.pluginId }, bytes)
      },
      readContent: (provider, handle) => {
        if (!contentHandles) throw new Error("IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE")
        return contentHandles.download(
          { ...provider, pluginId: runtimeDescriptor.pluginId },
          handle
        )
      },
    })
  } catch (error) {
    managedStorage.dispose()
    throw error
  }
  let protocolRegistration
  try {
    const { registerManagedProtocols } = await import("./protocol-adapters.mjs")
    const protocolParams = (family, server, extra = {}) => ({
      invocationId: randomUUID(),
      pluginId: runtimeDescriptor.pluginId,
      pluginVersion: runtimeDescriptor.pluginVersion,
      manifestHash: runtimeDescriptor.manifestHash,
      catalogHash: runtimeDescriptor.catalogHash,
      hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
      workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
      workspaceTrusted: vscode.workspace.isTrusted,
      family,
      protocolId: server.id,
      ...extra,
    })
    protocolRegistration = await registerManagedProtocols(vscode, runtimeDescriptor, {
      onEvent: (listener) =>
        bridge.onNotification((message) => {
          if (message?.pluginId === runtimeDescriptor.pluginId) listener(message)
        }),
      startProtocol: (family, server, consumerId) =>
        bridge.request(
          "cognia/protocol/start",
          protocolParams(family, server, consumerId ? { consumerId } : {})
        ),
      requestProtocol: (family, server, capabilityTicket, method, payload, token, consumerId) => {
        const invocationId = randomUUID()
        const request = bridge.request(
          "cognia/protocol/request",
          protocolParams(family, server, {
            invocationId,
            capabilityTicket,
            method,
            payload,
            ...(consumerId ? { consumerId } : {}),
          })
        )
        token?.onCancellationRequested(() => {
          bridge?.notify("cognia/protocol/cancel", {
            invocationId,
            pluginId: runtimeDescriptor.pluginId,
            protocolId: server.id,
            ...(consumerId ? { consumerId } : {}),
          })
        })
        return request
      },
      documentProtocol: (family, server, capabilityTicket, document, consumerId) =>
        bridge.request(
          "cognia/protocol/document",
          protocolParams(family, server, {
            capabilityTicket,
            document,
            ...(consumerId ? { consumerId } : {}),
          })
        ),
      stopProtocol: (family, server, capabilityTicket, consumerId) =>
        bridge.request(
          "cognia/protocol/stop",
          protocolParams(family, server, {
            capabilityTicket,
            ...(consumerId ? { consumerId } : {}),
          })
        ),
    })
  } catch (error) {
    providerRegistration.dispose()
    managedStorage.dispose()
    throw error
  }
  const registration = vscode.Disposable.from(
    managedStorage,
    providerRegistration,
    protocolRegistration
  )
  const previous = proxyRegistrations.get(runtimeDescriptor.pluginId)
  previous?.dispose()
  proxyRegistrations.set(runtimeDescriptor.pluginId, registration)
  context.subscriptions.push(registration)
  return {
    generation: bridge.negotiated?.generation,
    providerCount: runtimeDescriptor.providers?.length ?? 0,
    managedContext: {
      globalState: managedStorage.globalState,
      workspaceState: managedStorage.workspaceState,
      secrets: managedStorage.secrets,
    },
  }
}

export function activate(context) {
  const portRaw = process.env.COGNIA_CS_AGENT_PORT
  const token = process.env.COGNIA_CS_AGENT_TOKEN
  // Not launched by Cognia — stay completely dormant.
  if (!portRaw || !token) return undefined
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) return undefined
  const protocolMode = process.env.COGNIA_CS_BROKER_PROTOCOL === "1" ? "jsonrpc" : "legacy"
  const contentPort = Number(process.env.COGNIA_CS_CONTENT_PORT)
  if (protocolMode === "jsonrpc" && (!Number.isInteger(contentPort) || contentPort <= 0)) {
    return undefined
  }

  proposedEmitter = new vscode.EventEmitter()
  context.subscriptions.push(
    proposedEmitter,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
      onDidChange: proposedEmitter.event,
      provideTextDocumentContent: (uri) => proposedContents.get(uri.toString()) ?? "",
    })
  )

  bridge = new AgentBridge(port, token, protocolMode)
  contentHandles =
    protocolMode === "jsonrpc"
      ? new ContentHandleClient({ port: contentPort, credential: token })
      : null
  bridge.start()

  // Push editor state instead of making the app poll for it. Every handler reports
  // only the shape the app needs to decide whether to re-read — the authoritative
  // snapshot still comes from `readActive`, so these stay small and cheap.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      bridge?.emit("activeEditorChanged", () => ({
        path: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
      }))
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // Only the focused editor: a background editor's selection changing (e.g. from
      // a find-all) is not "what the user is looking at".
      if (event.textEditor !== vscode.window.activeTextEditor) return
      bridge?.emit("selectionChanged", () => ({
        path: event.textEditor.document.uri.fsPath,
        empty: event.textEditor.selection.isEmpty,
      }))
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return
      bridge?.emit("documentSaved", () => ({ path: doc.uri.fsPath }))
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      const active = vscode.window.activeTextEditor?.document
      if (!active || active.uri.scheme !== "file") return
      bridge?.emit("diagnosticsChanged", () => ({
        path: active.uri.fsPath,
        count: vscode.languages.getDiagnostics(active.uri).length,
      }))
    }),
    {
      dispose: () => {
        bridge?.dispose()
        bridge = null
        proposedContents.clear()
        proposedEmitter = null
      },
    }
  )

  // ── Chat context commands ──────────────────────────────────────────────
  // These register the right-click menu actions that push editor context to
  // the Cognia chat via the event channel. The renderer stages the payload as
  // a FileSelectionRef context chip and optionally pre-fills the composer.
  context.subscriptions.push(
    vscode.commands.registerCommand("cognia.chat.addSelection", () => {
      const ctx = captureChatContext("addSelection")
      if (ctx) bridge?.emit("chatContextRequested", () => ctx)
    }),
    vscode.commands.registerCommand("cognia.chat.addFile", (uri) => {
      // `uri` is provided when invoked from the explorer context menu
      const ctx = uri ? captureFileContext(uri) : captureChatContext("addFile")
      if (ctx) bridge?.emit("chatContextRequested", () => ctx)
    }),
    vscode.commands.registerCommand("cognia.chat.explain", () => {
      const ctx = captureChatContext("explain")
      if (ctx) bridge?.emit("chatContextRequested", () => ctx)
    }),
    vscode.commands.registerCommand("cognia.chat.fix", () => {
      const ctx = captureChatContext("fix")
      if (ctx) bridge?.emit("chatContextRequested", () => ctx)
    }),
    vscode.commands.registerCommand("cognia.chat.review", () => {
      const ctx = captureChatContext("review")
      if (ctx) bridge?.emit("chatContextRequested", () => ctx)
    }),
    vscode.commands.registerCommand("cognia.chat.customAction", async () => {
      const customActions = vscode.workspace.getConfiguration("cognia").get("customActions", [])
      if (customActions.length === 0) {
        vscode.window.showInformationMessage(
          "No custom actions configured. Add them in Settings → Cognia → Custom Actions."
        )
        return
      }
      const picked = await vscode.window.showQuickPick(
        customActions.map((a) => ({ label: a.label, description: a.prompt, action: a })),
        { placeHolder: "Choose a Cognia action" }
      )
      if (!picked) return
      const ctx = captureChatContext("custom")
      if (!ctx) return
      ctx.customPrompt = picked.action.prompt
      ctx.customLabel = picked.action.label
      bridge?.emit("chatContextRequested", () => ctx)
    })
  )

  return {
    registerProxy: (proxyContext, descriptor) => registerProxy(proxyContext, descriptor),
  }
}

export function deactivate() {
  bridge?.dispose()
  bridge = null
  proposedContents.clear()
  proposedEmitter = null
  for (const registration of proxyRegistrations.values()) registration.dispose()
  proxyRegistrations.clear()
}
