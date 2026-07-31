/**
 * Stable diagnostic identity + a small factory. The id is deterministic in
 * `(code, nodeId, edgeId, field)` so the same underlying problem keeps the
 * same React key across recomputes — the Problems panel must not lose its
 * selection or re-animate rows when an unrelated node changes.
 */

import type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from "./types"

export function diagId(
  code: DiagnosticCode,
  parts: { nodeId?: string; edgeId?: string; field?: string }
): string {
  return [code, parts.nodeId ?? "", parts.edgeId ?? "", parts.field ?? ""].join("|")
}

export interface MakeDiagnosticOptions {
  severity: DiagnosticSeverity
  code: DiagnosticCode
  nodeId?: string
  edgeId?: string
  field?: string
  /** Defaults to `workflows.diagnostics.<code>`. */
  messageKey?: string
  messageParams?: Record<string, string | number>
}

export function makeDiagnostic(opts: MakeDiagnosticOptions): Diagnostic {
  const { severity, code, nodeId, edgeId, field, messageParams } = opts
  return {
    id: diagId(code, { nodeId, edgeId, field }),
    severity,
    code,
    nodeId,
    edgeId,
    field,
    messageKey: opts.messageKey ?? `workflows.diagnostics.${code}`,
    messageParams,
  }
}
