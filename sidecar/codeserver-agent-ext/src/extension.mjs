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
  helloFrame,
  parseRequest,
  responseFrame,
  splitFrames,
  toZeroBased,
} from "./protocol.mjs"

/** Delay before retrying a dropped connection to the app's agent channel. */
const RECONNECT_DELAY_MS = 1000

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
  }

  start() {
    this.connect()
  }

  dispose() {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.destroy()
    this.socket = null
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
    default:
      throw new Error(`unknown method: ${method}`)
  }
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

let bridge = null

export function activate(context) {
  const portRaw = process.env.COGNIA_CS_AGENT_PORT
  const token = process.env.COGNIA_CS_AGENT_TOKEN
  // Not launched by Cognia — stay completely dormant.
  if (!portRaw || !token) return
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) return

  bridge = new AgentBridge(port, token)
  bridge.start()
  context.subscriptions.push({
    dispose: () => {
      bridge?.dispose()
      bridge = null
    },
  })
}

export function deactivate() {
  bridge?.dispose()
  bridge = null
}
