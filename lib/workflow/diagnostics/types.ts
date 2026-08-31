/**
 * Diagnostics contract for the visual workflow editor. A single typed
 * `Diagnostic[]` produced by `runDiagnostics` (`./engine.ts`) and consumed by
 * the editor store, the Problems panel, and node/edge decorations.
 *
 * Every diagnostic carries a stable `id` (see `./diagnostic-id.ts`) so the
 * Problems panel keeps React keys across recomputes, and an i18n `messageKey`
 * (+ optional interpolation params) so no English leaks into the UI.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"

export type DiagnosticSeverity = "error" | "warning" | "info"

export type DiagnosticCode =
  // node param validation (Zod, per kind)
  | "nodeParam"
  // graph integrity (shared with lib/workflow/definition/validate.ts)
  | "duplicateNodeId"
  | "duplicateEdgeId"
  | "danglingSource"
  | "danglingTarget"
  | "invalidConnection"
  | "missingTrigger"
  | "selfParent"
  | "missingParent"
  | "parentNotContainer"
  | "flowOutsideLoop"
  | "containerBoundary"
  | "graphCycle"
  // editor-only structural / semantic checks
  | "orphanNode"
  | "exprUnknownNode"
  | "exprNotUpstream"
  | "credentialMissing"
  | "pluginUnavailable"
  | "kindRetired"
  | "desktopOnlyInWeb"
  | "joinPolicyInLoop"
  | "synthesizerOnly"

export interface Diagnostic {
  /** Stable identity across recomputes — `diagId(code, {nodeId,edgeId,field})`. */
  id: string
  severity: DiagnosticSeverity
  code: DiagnosticCode
  /** The node this diagnostic points at (click-to-navigate target). */
  nodeId?: string
  /** The edge this diagnostic points at. */
  edgeId?: string
  /** Top-level form field, for inspector field highlighting. */
  field?: string
  /** i18n message key, e.g. `workflows.diagnostics.orphanNode`. */
  messageKey: string
  /** Interpolation values for the message (e.g. `{ ref: "n_3" }`). */
  messageParams?: Record<string, string | number>
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  errorCount: number
  warningCount: number
  infoCount: number
  /** Diagnostics grouped by `nodeId` — for the node corner badge. */
  byNodeId: Record<string, Diagnostic[]>
  /** Diagnostics grouped by `edgeId` — for the edge decoration. */
  byEdgeId: Record<string, Diagnostic[]>
}

export interface DiagnosticsInput {
  workflow: VisualWorkflow
  /** `true` in browser mode — gates the desktop-only-node warning. */
  isWeb: boolean
  /**
   * Optional registry-backed predicate: is a (plugin) node kind currently
   * available/installed? When provided, unknown plugin kinds raise a
   * `pluginUnavailable` warning. Injected so the engine stays pure/testable.
   */
  isKindAvailable?: (kind: string) => boolean
}

export const EMPTY_DIAGNOSTICS: DiagnosticsResult = {
  diagnostics: [],
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  byNodeId: {},
  byEdgeId: {},
}
