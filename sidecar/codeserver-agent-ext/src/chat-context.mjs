// Editor context the Cognia commands hand to the app's chat composer.
//
// Takes `vscode` as a parameter rather than importing it, so the real
// functions — not a copy — run under `node --test` against a fake API.

import { diagnosticSeverityName } from "./protocol.mjs"

/** Maximum snapshot size for chat context to avoid blowing up the chat store. */
export const MAX_CHAT_SNAPSHOT_CHARS = 20_000

/**
 * Capture the current editor context for a chat action. Returns null when
 * there is nothing actionable (no active file-based editor).
 */
export function captureChatContext(vscode, action) {
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
export function captureFileContext(vscode, uri) {
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

/**
 * Everything the workspace's Problems panel currently reports, shaped like the
 * chat-context payload the app already knows how to stage.
 *
 * Errors and warnings only: hints and info are editor chatter (spelling,
 * unused-import suggestions) and would bury the two severities a person
 * actually wants to hand over. Returns null when there is nothing to send, so
 * the command can say so instead of staging an empty context chip.
 */
export function captureDiagnosticsContext(vscode) {
  const files = []
  let total = 0
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    const relevant = diagnostics.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    )
    if (relevant.length === 0) continue
    total += relevant.length
    files.push({
      path: uri.fsPath,
      relativePath: vscode.workspace.asRelativePath(uri, false),
      diagnostics: relevant.map((d) => ({
        message: d.message,
        severity: diagnosticSeverityName(d.severity),
        // VS Code ranges are already 0-based; the payload is 1-based.
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
      })),
    })
  }
  if (total === 0) return null
  return { total, files }
}
