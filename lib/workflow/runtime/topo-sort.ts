/**
 * Kahn-style topological sort with cycle detection. Used by the orchestrator
 * to compute step execution order.
 *
 * The sorter operates on the validated graph — `validateGraphIntegrity` has
 * already rejected dangling endpoints and ALL cycles (iteration lives inside
 * `flow.loop` v2 containers, never in top-level back-edges). Historically the
 * sorter silently REMOVED edges targeting `flow.loop`/`flow.wait` nodes as
 * "authorized back-edges" — but the scheduler never re-traversed them, so a
 * cyclic graph ran every node exactly once while looking valid. That
 * tolerance is gone: a cycle that reaches this function (i.e. snuck past
 * validation) now throws loudly instead of degrading to a single pass.
 */

import type { VisualWorkflow, WorkflowEdge } from "@/types/workflow/visual"

export interface TopoSortResult {
  /** Stable order of node ids that respects all forward edges. */
  order: string[]
  /**
   * Always empty since the back-edge tolerance was removed; kept in the
   * result shape so downstream call sites need no change if a future
   * event-resume design reintroduces genuine back-edges.
   */
  backEdges: WorkflowEdge[]
}

export function topoSort(workflow: VisualWorkflow): TopoSortResult {
  const forwardEdges = workflow.edges
  const backEdges: WorkflowEdge[] = []

  // Kahn's algorithm on the forward edges.
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of workflow.nodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const edge of forwardEdges) {
    if (!inDegree.has(edge.target) || !adj.has(edge.source)) continue
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    adj.get(edge.source)!.push(edge.target)
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }
  // Stable: sort by the node array's original order so re-runs produce
  // identical traces.
  const idIndex = new Map(workflow.nodes.map((n, i) => [n.id, i] as const))
  queue.sort((a, b) => (idIndex.get(a) ?? 0) - (idIndex.get(b) ?? 0))

  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    const next = adj.get(id) ?? []
    for (const target of next) {
      const deg = (inDegree.get(target) ?? 0) - 1
      inDegree.set(target, deg)
      if (deg === 0) queue.push(target)
    }
    queue.sort((a, b) => (idIndex.get(a) ?? 0) - (idIndex.get(b) ?? 0))
  }

  // If we didn't reach every node, the graph has a cycle — which means
  // validateGraphIntegrity missed it (a caller skipped validation). Surface
  // it loudly rather than running a partial order.
  if (order.length !== workflow.nodes.length) {
    const remaining = workflow.nodes.map((n) => n.id).filter((id) => !order.includes(id))
    throw new Error(
      `Cycle detected through nodes: ${remaining.join(", ")}. ` +
        "Top-level back-edges never re-execute — move the nodes that should repeat " +
        "INSIDE a flow.loop container (typeVersion 2) instead."
    )
  }

  return { order, backEdges }
}

/**
 * Returns the immediate downstream node ids for `nodeId`. Useful when the
 * orchestrator needs to enqueue successors after a step completes.
 */
export function downstream(workflow: VisualWorkflow, nodeId: string): string[] {
  return workflow.edges.filter((e) => e.source === nodeId).map((e) => e.target)
}

/**
 * Returns the immediate upstream node ids for `nodeId`. Used to gather
 * input outputs for the step executor.
 */
export function upstream(workflow: VisualWorkflow, nodeId: string): string[] {
  return workflow.edges.filter((e) => e.target === nodeId).map((e) => e.source)
}
