// Cognia Agent Bridge — a VS Code extension side-loaded into the embedded
// code-server (Pro IDE Phase 2). It dials the app's loopback agent channel and
// lets the Cognia agent drive the live editor: open/reveal a file, reflect an
// on-disk write as an undo-able edit, and read the active-editor context back.
//
// Dormant unless launched by Cognia: `activate` returns immediately when the
// `COGNIA_CS_AGENT_PORT` / `COGNIA_CS_AGENT_TOKEN` env vars are absent, so the
// extension is inert in any other code-server.

import * as net from "node:net"
import * as vscode from "vscode"
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

/**
 * Owns the single TCP connection back to the app and dispatches inbound request
 * frames to the editor handlers. Reconnects with a fixed backoff so a transient
 * app-side restart doesn't leave the bridge dead.
 */
class AgentBridge {
  constructor(port, token) {
    this.port = port
    this.token = token
    this.socket = null
    this.buffer = ""
    this.disposed = false
    this.reconnectTimer = null
    this.coalesceTimers = new Map()
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
          this.socket.write(eventFrame(name, payloadFn()))
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
      socket.write(helloFrame(this.token))
    })
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => this.onData(chunk))
    // Errors surface as a `close`; swallow so an unhandled 'error' can't crash
    // the extension host.
    socket.on("error", () => {})
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null
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
}

/** Route a request method to its editor handler. */
async function dispatch(method, params) {
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
    default:
      throw new Error(`unknown method: ${method}`)
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

let bridge = null

export function activate(context) {
  const portRaw = process.env.COGNIA_CS_AGENT_PORT
  const token = process.env.COGNIA_CS_AGENT_TOKEN
  // Not launched by Cognia — stay completely dormant.
  if (!portRaw || !token) return
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) return

  proposedEmitter = new vscode.EventEmitter()
  context.subscriptions.push(
    proposedEmitter,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
      onDidChange: proposedEmitter.event,
      provideTextDocumentContent: (uri) => proposedContents.get(uri.toString()) ?? "",
    })
  )

  bridge = new AgentBridge(port, token)
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
}

export function deactivate() {
  bridge?.dispose()
  bridge = null
  proposedContents.clear()
  proposedEmitter = null
}
