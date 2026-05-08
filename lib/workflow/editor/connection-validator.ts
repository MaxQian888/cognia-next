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

export interface ConnectionParams {
  source: string | null
  target: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface NodeShapeForValidation {
  id: string
  data: { kind: WorkflowNodeKind }
}

export interface EdgeShapeForValidation {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export type ValidationResult = { valid: true } | { valid: false; reason: string }

export function validateConnection(
  params: ConnectionParams,
  nodes: NodeShapeForValidation[],
  edges: EdgeShapeForValidation[]
): ValidationResult {
  if (!params.source || !params.target) {
    return { valid: false, reason: "Connection must have both endpoints." }
  }
  if (params.source === params.target) {
    return { valid: false, reason: "Self-loops are not allowed." }
  }
  const source = nodes.find((n) => n.id === params.source)
  const target = nodes.find((n) => n.id === params.target)
  if (!source || !target) {
    return { valid: false, reason: "Endpoint node missing from the graph." }
  }
  if (target.data.kind.startsWith("trigger.")) {
    return { valid: false, reason: "Triggers are sources only." }
  }
  if (
    source.data.kind === "annotation.note" ||
    source.data.kind === "annotation.group" ||
    target.data.kind === "annotation.note" ||
    target.data.kind === "annotation.group"
  ) {
    return { valid: false, reason: "Annotations have no execution and cannot be connected." }
  }
  const exists = edges.some(
    (e) =>
      e.source === params.source &&
      e.target === params.target &&
      (e.sourceHandle ?? null) === (params.sourceHandle ?? null) &&
      (e.targetHandle ?? null) === (params.targetHandle ?? null)
  )
  if (exists) {
    return { valid: false, reason: "Duplicate edge — these nodes are already connected." }
  }
  return { valid: true }
}
