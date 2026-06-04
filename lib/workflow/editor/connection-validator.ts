/**
 * Connection validator — gates the edges users can draw on the canvas.
 *
 * Rules (kept simple and conservative — better to allow than to block, since
 * the orchestrator will catch real graph errors at run time):
 *
 *   1. Triggers are sources only. They cannot be the `target` of any edge.
 *   2. Annotations (note / group) are display-only. They cannot connect to
 *      anything in either direction.
 *   3. Self-loops are forbidden (source === target).
 *   4. Duplicate edges (same source+target+sourceHandle+targetHandle) are
 *      forbidden — the user almost never wants two parallel identical edges,
 *      and the orchestrator treats them as one anyway.
 *
 * Returns either `{ valid: true }` or `{ valid: false, reason }`. Callers
 * surface `reason` to the user via toast / inline warning.
 */

import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { outputHandlesFor } from "./node-handles"

export interface ConnectionParams {
  source: string | null
  target: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface NodeShapeForValidation {
  id: string
  data: {
    kind: WorkflowNodeKind
    /** Present when the caller passes full React Flow nodes (the canvas
     * does); enables labeled-output-handle validation for v2 nodes. */
    typeVersion?: number
    params?: Record<string, unknown>
  }
}

export interface EdgeShapeForValidation {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/**
 * `reasonKey` is a stable i18n key under `workflows.editor.connection.*`;
 * `reason` is the English fallback for non-UI callers (tests, logs).
 */
export type ValidationResult = { valid: true } | { valid: false; reason: string; reasonKey: string }

export function validateConnection(
  params: ConnectionParams,
  nodes: NodeShapeForValidation[],
  edges: EdgeShapeForValidation[]
): ValidationResult {
  if (!params.source || !params.target) {
    return {
      valid: false,
      reason: "Connection must have both endpoints.",
      reasonKey: "missingEndpoint",
    }
  }
  if (params.source === params.target) {
    return { valid: false, reason: "Self-loops are not allowed.", reasonKey: "selfLoop" }
  }
  const source = nodes.find((n) => n.id === params.source)
  const target = nodes.find((n) => n.id === params.target)
  if (!source || !target) {
    return {
      valid: false,
      reason: "Endpoint node missing from the graph.",
      reasonKey: "endpointMissing",
    }
  }
  if (target.data.kind.startsWith("trigger.")) {
    return { valid: false, reason: "Triggers are sources only.", reasonKey: "triggerTarget" }
  }
  if (
    source.data.kind === "annotation.note" ||
    source.data.kind === "annotation.group" ||
    target.data.kind === "annotation.note" ||
    target.data.kind === "annotation.group"
  ) {
    return {
      valid: false,
      reason: "Annotations have no execution and cannot be connected.",
      reasonKey: "annotation",
    }
  }
  // Labeled-output-handle integrity (branch/switch v2). Only enforceable when
  // the caller supplied typeVersion + params (the canvas always does); shape-
  // only callers skip this check, preserving the "allow over block" posture.
  if (typeof source.data.typeVersion === "number") {
    const handles = outputHandlesFor({
      kind: source.data.kind,
      typeVersion: source.data.typeVersion,
      params: source.data.params ?? {},
    })
    if (handles && params.sourceHandle !== "error") {
      if (params.sourceHandle === undefined || params.sourceHandle === null) {
        return {
          valid: false,
          reason: "Pick one of this node's output handles.",
          reasonKey: "handleRequired",
        }
      }
      if (!handles.some((h) => h.id === params.sourceHandle)) {
        return {
          valid: false,
          reason: "Unknown output handle on the source node.",
          reasonKey: "unknownHandle",
        }
      }
    }
  }
  const exists = edges.some(
    (e) =>
      e.source === params.source &&
      e.target === params.target &&
      (e.sourceHandle ?? null) === (params.sourceHandle ?? null) &&
      (e.targetHandle ?? null) === (params.targetHandle ?? null)
  )
  if (exists) {
    return {
      valid: false,
      reason: "Duplicate edge — these nodes are already connected.",
      reasonKey: "duplicateEdge",
    }
  }
  return { valid: true }
}
