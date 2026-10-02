// The editor verbs the app drives over the broker: open/reveal, reflect an
// agent edit, read the active editor, save, diff, terminal, notify, and the
// managed-proxy activation transaction.
//
// Takes `vscode` as a parameter so the real handlers run under `node --test`
// against a fake API. Every verb receives `{ signal, reportProgress }`:
// `signal` aborts when the host withdraws the request (`$/cancelRequest`), and
// verbs that write check it before each step that changes something;
// `reportProgress` sends `$/progress` for the request, which also renews its
// deadline on the host.

import {
  diagnosticSeverityName,
  editReflectionAction,
  notificationKind,
  toZeroBased,
} from "./protocol.mjs"

/** The in-memory scheme backing `showDiff`'s right-hand side. */
export const PROPOSED_SCHEME = "cognia-proposed"

export class RequestCancelledError extends Error {
  constructor() {
    super("Request cancelled")
    this.name = "RequestCancelledError"
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new RequestCancelledError()
}

const NO_PROGRESS = () => {}

/**
 * Build the verb dispatcher.
 *
 * - `onSnapshot(params)` receives a pushed workspace snapshot.
 * - `getProxyRegistration(pluginId)` returns the live registration a proxy
 *   extension made through `registerProxy`, for the activation handshake.
 */
export function createEditorVerbs(vscode, { onSnapshot, getProxyRegistration }) {
  /**
   * In-memory store backing the `showDiff` right-hand side.
   *
   * A `TextDocumentContentProvider` rather than a temp file: a proposal written
   * to disk would appear in the project tree, in `git status`, and — worst — in
   * the agent's own next directory listing, which is exactly the confusion a
   * pre-flight review is supposed to prevent.
   */
  const proposedContents = new Map()
  const proposedEmitter = new vscode.EventEmitter()
  const proposedProvider = {
    onDidChange: proposedEmitter.event,
    provideTextDocumentContent: (uri) => proposedContents.get(uri.toString()) ?? "",
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

  async function openFile(params, { signal }) {
    const path = String(params.path ?? "")
    if (!path) throw new Error("openFile requires a path")
    throwIfAborted(signal)
    await revealFile(path, params.line, params.column)
    return { opened: true, path }
  }

  /**
   * Reflect an agent's on-disk write as an undo-able edit. Disk is the source of
   * truth (the agent already wrote it); if the file is open with a stale buffer
   * we replace it via a WorkspaceEdit so the change enters VS Code's undo stack,
   * then save to clear the dirty flag (otherwise the file-watcher's later reload
   * would pop a "changed on disk" conflict). Closed or already-reconciled files
   * just get revealed — there is nothing to make undo-able.
   */
  async function applyEdit(params, { signal, reportProgress }) {
    const path = String(params.path ?? "")
    if (!path) throw new Error("applyEdit requires a path")
    const uri = vscode.Uri.file(path)
    reportProgress({ kind: "begin", operation: "applyEdit", path })
    try {
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
        throwIfAborted(signal)
        const current = openDoc.getText()
        const fullRange = new vscode.Range(
          openDoc.positionAt(0),
          openDoc.positionAt(current.length)
        )
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

      throwIfAborted(signal)
      await revealFile(path, params.line, params.column)
      return { reflected, opened: true, path }
    } finally {
      reportProgress({ kind: "end", operation: "applyEdit", path })
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

  /**
   * Flush dirty editor buffers to disk.
   *
   * Closes a real correctness hole rather than adding a convenience: the agent's
   * file tools read and write the filesystem directly, so any buffer the user has
   * edited but not saved is invisible to them. Before this, an agent asked to
   * "fix the bug in this file" would read the *stale* on-disk copy, reason about
   * code the user had already changed, and then overwrite their unsaved work.
   *
   * Scoped to `path` when given, otherwise every dirty file editor. Untitled
   * documents are skipped — they have no path for the agent to read, and saving
   * one would pop a modal file dialog in the middle of an agent turn. A
   * cancellation stops before the next file; what was saved stays saved and is
   * reported.
   */
  async function saveAll(params, { signal, reportProgress }) {
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
    reportProgress({ kind: "begin", operation: "saveAll", total: dirty.length })
    try {
      for (const [index, doc] of dirty.entries()) {
        throwIfAborted(signal)
        try {
          if (await doc.save()) saved.push(doc.uri.fsPath)
          else failed.push(doc.uri.fsPath)
        } catch {
          failed.push(doc.uri.fsPath)
        }
        reportProgress({
          kind: "report",
          operation: "saveAll",
          done: index + 1,
          total: dirty.length,
          percentage: Math.round(((index + 1) / dirty.length) * 100),
        })
      }
    } finally {
      reportProgress({ kind: "end", operation: "saveAll", total: dirty.length })
    }
    // Reported rather than thrown: a partial flush is still progress, and the
    // caller needs to know *which* files it cannot trust the disk copy of.
    return { saved, failed }
  }

  /**
   * Open VS Code's native diff editor between the file on disk and a proposed
   * revision, so an agent change can be reviewed before it lands. The proposal
   * rides in as `content` and is materialised through the in-memory
   * `cognia-proposed:` document, never a temp file on disk.
   */
  async function showDiff(params, { signal }) {
    const path = String(params.path ?? "")
    if (!path) throw new Error("showDiff requires a path")
    if (typeof params.content !== "string") throw new Error("showDiff requires content")
    throwIfAborted(signal)
    const left = vscode.Uri.file(path)
    const right = left.with({ scheme: PROPOSED_SCHEME })
    proposedContents.set(right.toString(), params.content)
    proposedEmitter.fire(right)
    const title = params.title ? String(params.title) : `${basename(path)} — proposed`
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true })
    return { shown: true, path }
  }

  /** Reveal a path in the file explorer and focus its tree item. */
  async function revealInExplorer(params, { signal }) {
    const path = String(params.path ?? "")
    if (!path) throw new Error("revealInExplorer requires a path")
    throwIfAborted(signal)
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path))
    return { revealed: true, path }
  }

  /**
   * Run a command in a VS Code integrated terminal, reusing the one named for the
   * app so repeated calls share history instead of spawning a terminal each time.
   *
   * `sendText` only — the extension host cannot read a terminal's output back, so
   * this is explicitly "show the user this command running", not a way for the
   * agent to collect output. The agent has its own shell tool for that. A
   * withdrawn request never types the command.
   */
  async function runInTerminal(params, { signal }) {
    const command = String(params.command ?? "")
    if (!command) throw new Error("runInTerminal requires a command")
    const name = params.name ? String(params.name) : "Cognia"
    const existing = vscode.window.terminals.find((t) => t.name === name && t.exitStatus == null)
    throwIfAborted(signal)
    const terminal =
      existing ??
      vscode.window.createTerminal({
        name,
        cwd: params.cwd ? String(params.cwd) : undefined,
      })
    terminal.show(true)
    throwIfAborted(signal)
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

  /**
   * Apply a pushed workspace snapshot. Tolerant of a partial payload: a snapshot
   * missing `groups` still updates the status bar, because a connected-but-empty
   * panel is a truthful state and throwing here would only drop the connection.
   */
  async function workspaceSnapshot(params) {
    if (!params || typeof params !== "object") {
      throw new Error("workspaceSnapshot requires an object")
    }
    onSnapshot(params)
    return null
  }

  /**
   * The managed-proxy activation transaction's verification step: activate the
   * proxy extension and confirm the descriptor it registered matches what the
   * host staged. The host only sends this on a connection that negotiated
   * `contribution-transactions`.
   */
  async function managedProxyHandshake(params, { signal, reportProgress }) {
    const pluginId = String(params?.pluginId ?? "")
    reportProgress({ kind: "begin", operation: "managedProxyHandshake", pluginId })
    try {
      const extensionName = `proxy-${pluginId
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-|-$/g, "")}`
      const extension = vscode.extensions.getExtension(`cognia-managed.${extensionName}`)
      if (!extension) throw new Error(`IDE_PROXY_EXTENSION_NOT_DISCOVERED: ${pluginId}`)
      if (!extension.isActive) await extension.activate()
      throwIfAborted(signal)
      const registration = getProxyRegistration(pluginId)
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
    } finally {
      reportProgress({ kind: "end", operation: "managedProxyHandshake", pluginId })
    }
  }

  async function restartManagedExtensionHost(_params, { signal }) {
    throwIfAborted(signal)
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost")
    return null
  }

  const verbs = {
    openFile,
    applyEdit,
    readActive,
    saveAll,
    showDiff,
    revealInExplorer,
    runInTerminal,
    notify,
    workspaceSnapshot,
    managedProxyHandshake,
    restartManagedExtensionHost,
  }

  /** Route a request method to its handler. */
  async function dispatch(method, params, { signal, reportProgress = NO_PROGRESS } = {}) {
    throwIfAborted(signal)
    const verb = Object.hasOwn(verbs, method) ? verbs[method] : null
    if (!verb) throw new Error(`unknown method: ${method}`)
    return verb(params ?? {}, { signal, reportProgress })
  }

  return {
    dispatch,
    openFile: (params) => openFile(params, {}),
    proposedProvider,
    dispose: () => {
      proposedContents.clear()
      proposedEmitter.dispose()
    },
  }
}

function basename(path) {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}
