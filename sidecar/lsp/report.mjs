// Format LSP diagnostics into a compact text block for the agent.
//
// The renderer's `lsp-protocol-adapter.ts` converts diagnostics into
// Monaco markers — the wrong shape for an LLM. This module produces the
// OpenCode-style `LSP.Diagnostic.report` text the model reads after an
// edit, e.g.:
//
//   src/foo.ts
//     12:5 ERROR Cannot find name 'bar'. [ts]
//     20:1 WARN 'baz' is declared but never read. [ts]

/** LSP DiagnosticSeverity (1..4) → label. */
const SEVERITY_LABEL = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }

/**
 * @param {string} filePath  Absolute or display path, used as the header.
 * @param {Array<{ range?: { start?: { line?: number, character?: number } }, severity?: number, message?: string, source?: string }>} diagnostics
 * @param {{ minSeverity?: number, includeHeader?: boolean }} [opts]
 *        minSeverity: highest numeric severity to include (default 2 =
 *        errors + warnings; LSP severity is ascending in badness so
 *        `<= minSeverity` keeps the more severe items).
 * @returns {string | null}  Formatted block, or null when nothing matches.
 */
export function formatDiagnostics(filePath, diagnostics, opts = {}) {
  const minSeverity = opts.minSeverity ?? 2
  const includeHeader = opts.includeHeader ?? true
  const items = (Array.isArray(diagnostics) ? diagnostics : []).filter(
    (d) => (d.severity ?? 1) <= minSeverity
  )
  if (items.length === 0) return null

  const lines = items.map((d) => {
    const line = (d.range?.start?.line ?? 0) + 1
    const col = (d.range?.start?.character ?? 0) + 1
    const sev = SEVERITY_LABEL[d.severity ?? 1] ?? "ERROR"
    const src = d.source ? ` [${d.source}]` : ""
    const msg = (d.message ?? "").replace(/\s+/g, " ").trim()
    return `  ${line}:${col} ${sev} ${msg}${src}`
  })

  return includeHeader ? `${filePath}\n${lines.join("\n")}` : lines.join("\n")
}

/**
 * Count diagnostics at or above (more severe than) `minSeverity`.
 * @param {Array<{ severity?: number }>} diagnostics
 * @param {number} [minSeverity]
 * @returns {number}
 */
export function countDiagnostics(diagnostics, minSeverity = 2) {
  return (Array.isArray(diagnostics) ? diagnostics : []).filter(
    (d) => (d.severity ?? 1) <= minSeverity
  ).length
}
