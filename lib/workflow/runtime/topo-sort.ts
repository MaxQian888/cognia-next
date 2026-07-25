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

import type { VisualWorkflow, WorkflowEdge, WorkflowNode } from "@/types/workflow/visual"

export interface WorkflowGraphIndex {
  nodeById: ReadonlyMap<string, WorkflowNode>
  incomingEdgesByNode: ReadonlyMap<string, readonly WorkflowEdge[]>
  outgoingEdgesByNode: ReadonlyMap<string, readonly WorkflowEdge[]>
}

/**
 * Build the immutable adjacency index shared by preparation and execution.
 * Keeping this per-run avoids repeatedly scanning every node/edge while the
 * orchestrator resolves dependencies, routes branches, and propagates skips.
 */
export function createWorkflowGraphIndex(workflow: VisualWorkflow): WorkflowGraphIndex {
  const nodeById = new Map<string, WorkflowNode>()
  const incomingEdgesByNode = new Map<string, WorkflowEdge[]>()
  const outgoingEdgesByNode = new Map<string, WorkflowEdge[]>()

  for (const node of workflow.nodes) {
    nodeById.set(node.id, node)
    incomingEdgesByNode.set(node.id, [])
    outgoingEdgesByNode.set(node.id, [])
  }
  for (const edge of workflow.edges) {
    outgoingEdgesByNode.get(edge.source)?.push(edge)
    incomingEdgesByNode.get(edge.target)?.push(edge)
  }

  return { nodeById, incomingEdgesByNode, outgoingEdgesByNode }
}

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

export function topoSort(
  workflow: VisualWorkflow,
  graph = createWorkflowGraphIndex(workflow)
): TopoSortResult {
  const forwardEdges = workflow.edges
  const backEdges: WorkflowEdge[] = []

  // Kahn's algorithm on the forward edges.
  const inDegree = new Map<string, number>()
  for (const n of workflow.nodes) {
    inDegree.set(n.id, 0)
  }
  for (const edge of forwardEdges) {
    if (!inDegree.has(edge.target) || !graph.nodeById.has(edge.source)) continue
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }

  // A min-heap of original node positions preserves deterministic order
  // without sorting and shifting the whole ready queue after every node.
  const queue: number[] = []
  const pushReady = (index: number): void => {
    queue.push(index)
    let child = queue.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (queue[parent] <= queue[child]) break
      ;[queue[parent], queue[child]] = [queue[child], queue[parent]]
      child = parent
    }
  }
  const popReady = (): number | undefined => {
    const first = queue[0]
    const last = queue.pop()
    if (last !== undefined && queue.length > 0) {
      queue[0] = last
      let parent = 0
      while (true) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent
        if (left < queue.length && queue[left] < queue[smallest]) smallest = left
        if (right < queue.length && queue[right] < queue[smallest]) smallest = right
        if (smallest === parent) break
        ;[queue[parent], queue[smallest]] = [queue[smallest], queue[parent]]
        parent = smallest
      }
    }
    return first
  }
  for (let index = 0; index < workflow.nodes.length; index += 1) {
    if ((inDegree.get(workflow.nodes[index].id) ?? 0) === 0) pushReady(index)
  }
  const nodeIndex = new Map(workflow.nodes.map((node, index) => [node.id, index] as const))

  const order: string[] = []
  while (queue.length > 0) {
    const index = popReady()!
    const id = workflow.nodes[index].id
    order.push(id)
    for (const edge of graph.outgoingEdgesByNode.get(id) ?? []) {
      const target = edge.target
      const deg = (inDegree.get(target) ?? 0) - 1
      inDegree.set(target, deg)
      const targetIndex = nodeIndex.get(target)
      if (deg === 0 && targetIndex !== undefined) pushReady(targetIndex)
    }
  }

  // If we didn't reach every node, the graph has a cycle — which means
  // validateGraphIntegrity missed it (a caller skipped validation). Surface
  // it loudly rather than running a partial order.
  if (order.length !== workflow.nodes.length) {
    const emitted = new Set(order)
    const remaining = workflow.nodes.map((n) => n.id).filter((id) => !emitted.has(id))
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
  return (createWorkflowGraphIndex(workflow).outgoingEdgesByNode.get(nodeId) ?? []).map(
    (edge) => edge.target
  )
}

/**
 * Returns the immediate upstream node ids for `nodeId`. Used to gather
 * input outputs for the step executor.
 */
export function upstream(workflow: VisualWorkflow, nodeId: string): string[] {
  return (createWorkflowGraphIndex(workflow).incomingEdgesByNode.get(nodeId) ?? []).map(
    (edge) => edge.source
  )
}
