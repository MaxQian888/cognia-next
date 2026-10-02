// Pure editor-verb helpers for the Cognia agent bridge extension.
//
// Kept free of the `vscode` API so the decisions are unit-testable with
// `node --test` (see `tests/protocol.test.mjs`). Framing lives in
// `jsonrpc.mjs`; the wire protocol is JSON-RPC 2.0 with `Content-Length`
// framing, matching `crates/cognia-codeserver/src/agent_channel.rs`.

/**
 * Convert an incoming 1-based line/column (editor-UI convention, matching the
 * app side) to a 0-based position for the VS Code API. Non-numbers → `null`.
 */
export function toZeroBased(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value) - 1)
}

/**
 * Decide whether an agent's on-disk write should be reflected as an undo-able
 * in-editor edit. Only worth it when the file is currently open AND its buffer
 * still differs from disk — if it's closed there is no undo history to preserve
 * (opening shows the new content), and if VS Code already reconciled the buffer
 * there is nothing to reflect. `openText` is `null` when the file is not open.
 */
export function shouldReflectEdit(diskText, openText) {
  return openText != null && openText !== diskText
}

/**
 * Classify how an on-disk agent write may be reconciled with an editor buffer.
 * A dirty buffer is never safe to replace: it contains user-authored changes
 * that have not reached disk, so the caller must surface a conflict instead of
 * silently applying or saving the agent's version.
 */
export function editReflectionAction(diskText, openText, isDirty) {
  if (openText != null && isDirty && openText !== diskText) return "conflict"
  return shouldReflectEdit(diskText, openText) ? "reflect" : "reveal"
}

/**
 * Narrow an app-supplied notification kind to one this extension can show.
 * Anything unrecognised (including undefined) reads as informational — a message
 * the app wanted surfaced must never be dropped because its kind was misspelled.
 */
export function notificationKind(value) {
  return value === "error" || value === "warning" ? value : "info"
}

/**
 * Map a VS Code `DiagnosticSeverity` (0=Error … 3=Hint) to the stable string the
 * app-side `CodeServerActiveEditor` type carries. Unknown values fall back to
 * `"info"`.
 */
export function diagnosticSeverityName(severity) {
  switch (severity) {
    case 0:
      return "error"
    case 1:
      return "warning"
    case 2:
      return "info"
    case 3:
      return "hint"
    default:
      return "info"
  }
}
