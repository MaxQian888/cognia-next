/**
 * Kahn-style topological sort with cycle detection. Used by the orchestrator
 * to compute step execution order. Cycles that pass through `flow.loop` /
 * `flow.wait` nodes are removed before sorting (they're back-edges) so the
 * caller can run a DAG in the normal case and only special-case the
 * declared back-edges.
 *
 * The sorter operates on the validated graph — `validateGraphIntegrity` has
 * already rejected dangling endpoints and unauthorized cycles.
 */

import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"

export interface TopoSortResult {
  /** Stable order of node ids that respects all forward edges. */
  order: string[]
  /** Edges that were removed because they form an authorized back-edge. */
  backEdges: WorkflowEdge[]
}

const BACK_EDGE_KINDS = new Set<WorkflowNode["type"]>(["flow.loop", "flow.wait"])

export function topoSort(workflow: VisualWorkflow): TopoSortResult {
  const nodeMap = new Map<string, WorkflowNode>()
  for (const n of workflow.nodes) nodeMap.set(n.id, n)

  // Identify back-edges before sorting. A back-edge is any edge whose target
  // is a flow.loop / flow.wait node — those are explicit "loop entry points"
  // and the orchestrator handles them with their own semantics.
  const backEdges: WorkflowEdge[] = []
  const forwardEdges: WorkflowEdge[] = []
  for (const edge of workflow.edges) {
    const targetNode = nodeMap.get(edge.target)
    const sourceNode = nodeMap.get(edge.source)
    if (
      targetNode &&
      sourceNode &&
      BACK_EDGE_KINDS.has(targetNode.type) &&
      // Only treat as back-edge if the target is "before" the source in any
      // BFS of forward edges. We approximate by checking whether source is
      // reachable from target via non-back-edges; if so, this is a cycle.
      isReachable(workflow.edges, edge.target, edge.source, BACK_EDGE_KINDS, nodeMap)
    ) {
      backEdges.push(edge)
    } else {
      forwardEdges.push(edge)
    }
  }

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

  // If we didn't reach every node, the (forward) graph still has a cycle —
  // which means validateGraphIntegrity missed it. Shouldn't happen if the
  // caller validates first, but we surface it loudly.
  if (order.length !== workflow.nodes.length) {
    const remaining = workflow.nodes.map((n) => n.id).filter((id) => !order.includes(id))
    throw new Error(`Cycle detected after back-edge removal: ${remaining.join(", ")}`)
  }

  return { order, backEdges }
}

/**
 * Returns true if `to` is reachable from `from` along edges whose target is
 * NOT one of the excluded kinds. Used to detect "is this a cycle?".
 */
function isReachable(
  edges: WorkflowEdge[],
  from: string,
  to: string,
  excludeKindsAtTarget: Set<WorkflowNode["type"]>,
  nodeMap: Map<string, WorkflowNode>
): boolean {
  if (from === to) return true
  const visited = new Set<string>([from])
  const stack: string[] = [from]
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    const targetNode = nodeMap.get(edge.target)
    if (targetNode && excludeKindsAtTarget.has(targetNode.type)) continue
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    adj.get(edge.source)!.push(edge.target)
  }
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const next of adj.get(cur) ?? []) {
      if (next === to) return true
      if (!visited.has(next)) {
        visited.add(next)
        stack.push(next)
      }
    }
  }
  return false
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
