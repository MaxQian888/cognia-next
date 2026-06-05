/**
 * Output-handle model for multi-output nodes (`flow.branch` / `flow.switch`
 * typeVersion 2) — the single source of truth shared by:
 *
 *   • the node renderer (`components/workflow/editor/nodes/workflow-node.tsx`)
 *     — which handles to draw and how to label them;
 *   • the connection validator (`./connection-validator.ts`) — which
 *     `sourceHandle` values are legal on edges leaving the node;
 *   • the smart edge (`components/workflow/editor/edges/smart-edge.tsx`)
 *     — what chip to render on an edge given its `sourceHandle`.
 *
 * Handle IDS are stable routing keys (the executor's `decision` values):
 * "true"/"false" for branch, the case id for switch cases, "default" for the
 * switch fall-through. Display LABELS are separate — `kind` tells the
 * renderer which i18n string to use ("true"/"false"/"default"), while case
 * handles carry the author's case label verbatim.
 *
 * The error handle is intentionally NOT modeled here — it's a workflow-level
 * concern (`errorPolicy: "branch"`) layered on by the renderer for every
 * fallible node, orthogonal to the kind-specific decision handles.
 */

import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface OutputHandleSpec {
  /** Stable handle id — used as the edge's `sourceHandle` and matched against
   * the executor's `decision`. */
  id: string
  /** Render intent: fixed kinds translate via i18n; `case` uses `label`. */
  kind: "true" | "false" | "case" | "default"
  /** Author-supplied display label (case handles only). */
  label?: string
}

export interface NodeShapeForHandles {
  kind: WorkflowNodeKind
  typeVersion: number
  params: Record<string, unknown>
}

interface SwitchCaseShape {
  id?: unknown
  label?: unknown
  when?: unknown
}

/**
 * Decision handles for a node, or `null` when the node renders the classic
 * single unlabeled output handle (all v1 nodes, and every non-routing kind).
 */
export function outputHandlesFor(node: NodeShapeForHandles): OutputHandleSpec[] | null {
  if (node.typeVersion < 2) return null
  if (node.kind === "flow.branch") {
    return [
      { id: "true", kind: "true" },
      { id: "false", kind: "false" },
    ]
  }
  if (node.kind === "flow.switch") {
    const raw = node.params.cases
    const cases: SwitchCaseShape[] = Array.isArray(raw) ? (raw as SwitchCaseShape[]) : []
    const handles: OutputHandleSpec[] = cases.map((c, i) => {
      const id = typeof c.id === "string" && c.id.trim() ? c.id : `case-${i}`
      const label = typeof c.label === "string" && c.label.trim() ? c.label : undefined
      return { id, kind: "case", label }
    })
    handles.push({ id: "default", kind: "default" })
    return handles
  }
  return null
}

/**
 * Authoring default `typeVersion` per kind. New canvas nodes for kinds with a
 * structured v2 params shape start at 2; existing graphs keep whatever
 * version they were authored with (executors for v1 stay registered).
 */
const DEFAULT_TYPE_VERSIONS: Partial<Record<WorkflowNodeKind, number>> = {
  "flow.branch": 2,
  "flow.switch": 2,
  // New loops author as container sub-canvases; legacy flat-transform loops
  // (typeVersion 1) keep running unchanged.
  "flow.loop": 2,
  // v2 adds routed mode (provider-routing engine), the PII gate, streaming,
  // and usage reporting; explicit mode stays wire-compatible with v1.
  "ai.prompt": 2,
}

export function defaultTypeVersionFor(kind: WorkflowNodeKind): number {
  return DEFAULT_TYPE_VERSIONS[kind] ?? 1
}

/**
 * Decide which loop container a dropped node should re-parent into.
 * `intersecting` is the set of loop-container nodes overlapping the drop
 * (the canvas filters by node type); the SMALLEST one wins so a drop into a
 * nested container picks the innermost. The dragged node itself and its own
 * descendants are never valid targets (that would create a parent cycle).
 * Returns the chosen container id, or `null` to leave the node top-level.
 */
export function pickContainerTarget(
  droppedId: string,
  intersecting: Array<{ id: string; width?: number | null; height?: number | null }>,
  allNodes: Array<{ id: string; parentId?: string }>
): string | null {
  const parentOf = new Map(allNodes.map((n) => [n.id, n.parentId]))
  const isSelfOrDescendantOfDropped = (id: string): boolean => {
    let cur: string | undefined = id
    let hops = 0
    while (cur !== undefined && hops <= allNodes.length) {
      if (cur === droppedId) return true
      cur = parentOf.get(cur)
      hops += 1
    }
    return false
  }
  const candidates = intersecting.filter((n) => !isSelfOrDescendantOfDropped(n.id))
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
  return candidates[0].id
}
