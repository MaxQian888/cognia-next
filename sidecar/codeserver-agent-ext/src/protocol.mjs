// Pure wire-protocol helpers for the Cognia agent bridge extension.
//
// Kept free of the `vscode` API so the framing/parsing logic is unit-testable
// with `node --test` (see `tests/protocol.test.mjs`). The transport is
// newline-delimited JSON over a loopback TCP socket — one JSON object per line
// — matching `src-tauri/src/codeserver/agent_channel.rs`.

/**
 * Split a receive buffer into complete lines, returning the leftover partial
 * line so the caller can prepend it to the next chunk. Blank lines are dropped.
 */
export function splitFrames(buffer) {
  const lines = []
  let rest = buffer
  let nl
  while ((nl = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (line) lines.push(line)
  }
  return { lines, rest }
}

/**
 * Parse a request line. Returns `null` for anything that is not a well-formed
 * `req` frame, so a malformed or hostile line is ignored rather than throwing.
 */
export function parseRequest(line) {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return null
  }
  if (
    !frame ||
    frame.type !== "req" ||
    typeof frame.id !== "number" ||
    typeof frame.method !== "string"
  ) {
    return null
  }
  return { id: frame.id, method: frame.method, params: frame.params ?? {} }
}

/** The one-time authentication frame sent right after connecting. */
export function helloFrame(token) {
  return JSON.stringify({ type: "hello", token }) + "\n"
}

/**
 * Build an unsolicited event frame (extension → app, no correlation id).
 *
 * The request/response pair only lets the app *ask*, which forces it to poll for
 * "what is the user looking at now". Events invert that: the extension reports
 * editor changes as they happen, and the app's active-editor subscribers refresh
 * off the signal instead of on a timer.
 */
export function eventFrame(name, payload) {
  return JSON.stringify({ type: "evt", name, payload: payload ?? null }) + "\n"
}

/**
 * Build a response frame correlated to a request `id`. `outcome` is either
 * `{ ok: true, result }` or `{ ok: false, error }`.
 */
export function responseFrame(id, outcome) {
  const frame = outcome.ok
    ? { type: "res", id, ok: true, result: outcome.result ?? null }
    : { type: "res", id, ok: false, error: outcome.error ?? "error" }
  return JSON.stringify(frame) + "\n"
}

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
