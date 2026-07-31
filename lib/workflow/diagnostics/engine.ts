/**
 * Workflow diagnostics engine — the single entry point that composes the
 * existing validators (param Zod schemas, graph integrity) with the
 * editor-only structural/semantic checks into one flat `Diagnostic[]`.
 *
 * Pure and synchronous: feed it a `VisualWorkflow` (+ environment flags) and
 * it returns a fully-indexed `DiagnosticsResult`. The editor store recomputes
 * it debounced; the runtime keeps using `validateGraphIntegrity` directly.
 */

import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { collectGraphIntegrityIssues } from "@/lib/workflow/definition/validate"
import { validateNodeParams } from "@/lib/workflow/nodes/validate-params"
import { diagId, makeDiagnostic } from "./diagnostic-id"
import { checkLoopBodyJoinPolicy, checkReachability } from "./checks/graph-structure"
import { checkExpressionRefs } from "./checks/expression-refs"
import { checkCredentials, checkKindAvailability } from "./checks/availability"
import { checkDesktopOnly } from "./checks/desktop-only"
import type { Diagnostic, DiagnosticCode, DiagnosticsInput, DiagnosticsResult } from "./types"

/** Per-node Zod param validation → one diagnostic per failing field. */
function adaptNodeParams(wf: VisualWorkflow): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    const result = validateNodeParams(node.type as WorkflowNodeKind, node.data?.params)
    if (!result.hasErrors) continue
    for (const [field, fieldError] of Object.entries(result.fields)) {
      out.push({
        id: diagId("nodeParam", { nodeId: node.id, field }),
        severity: "error",
        code: "nodeParam",
        nodeId: node.id,
        field,
        // Reuse the existing per-field i18n namespace rather than duplicating.
        messageKey: `workflows.validation.${fieldError.key}`,
        messageParams: fieldError.params,
      })
    }
  }
  return out
}

/** Shared graph-integrity issues → diagnostics (one source of truth with the runtime). */
function adaptGraphIntegrity(wf: VisualWorkflow): Diagnostic[] {
  return collectGraphIntegrityIssues(wf).map((issue) =>
    makeDiagnostic({
      severity: issue.severity,
      code: issue.code as DiagnosticCode,
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
      messageParams: issue.params,
    })
  )
}

/** Dedupe by id (first wins), build node/edge indexes, count by severity. */
function indexDiagnostics(list: Diagnostic[]): DiagnosticsResult {
  const seen = new Set<string>()
  const diagnostics: Diagnostic[] = []
  for (const d of list) {
    if (seen.has(d.id)) continue
    seen.add(d.id)
    diagnostics.push(d)
  }

  const byNodeId: Record<string, Diagnostic[]> = {}
  const byEdgeId: Record<string, Diagnostic[]> = {}
  let errorCount = 0
  let warningCount = 0
  let infoCount = 0
  for (const d of diagnostics) {
    if (d.severity === "error") errorCount++
    else if (d.severity === "warning") warningCount++
    else infoCount++
    if (d.nodeId) (byNodeId[d.nodeId] ??= []).push(d)
    if (d.edgeId) (byEdgeId[d.edgeId] ??= []).push(d)
  }
  return { diagnostics, errorCount, warningCount, infoCount, byNodeId, byEdgeId }
}

export function runDiagnostics(input: DiagnosticsInput): DiagnosticsResult {
  const { workflow, isWeb, isKindAvailable } = input
  const all: Diagnostic[] = [
    ...adaptNodeParams(workflow),
    ...adaptGraphIntegrity(workflow),
    ...checkReachability(workflow),
    ...checkLoopBodyJoinPolicy(workflow),
    ...checkExpressionRefs(workflow),
    ...checkCredentials(workflow),
    ...(isKindAvailable ? checkKindAvailability(workflow, isKindAvailable) : []),
    ...checkDesktopOnly(workflow, isWeb),
  ]
  return indexDiagnostics(all)
}
