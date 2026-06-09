/**
 * Upstream-graph reachability — the single source of truth for "which nodes
 * are upstream of node X" in the visual editor. Consumed by:
 *
 *   • expression autocomplete (`./expression-suggestions.ts`) — only upstream
 *     nodes may be offered as `$node['id']` references;
 *   • the variable picker (`variable-tree.ts`) — the tree of insertable refs;
 *   • expression-reference diagnostics (`./expression-diagnostics.ts` and
 *     `lib/workflow/diagnostics/checks/expression-refs.ts`) — a `$node` ref to
 *     a non-upstream node is out of scope.
 *
 * Operates on minimal structural shapes so both the diagnostics engine (which
 * holds `VisualWorkflow` nodes, kind in `.type`) and the editor store (which
 * holds React Flow nodes, kind in `.data`) can adapt with a one-line `.map`.
 *
 * Loop semantics mirror the orchestrator's topo-sort (`runtime/topo-sort.ts`):
 * an edge whose target is a `flow.loop` / `flow.wait` node AND which closes a
 * cycle is a back-edge and is ignored, so a loop body never becomes "upstream"
 * of its own loop entry. Unlike `topoSort`, this is cycle-tolerant — it never
 * throws — because the editor graph may legitimately contain in-progress
 * unauthorized cycles that diagnostics flags separately.
 */

export interface GraphNodeLike {
  id: string
  /** The workflow node kind, e.g. "action.agent.turn", "flow.loop". */
  kind: string
}

export interface GraphEdgeLike {
  source: string
  target: string
}

export interface UpstreamNode {
  id: string
  kind: string
  /** BFS distance from the query node (1 = immediate predecessor). */
  distance: number
}

/** Targets that turn a cycle-closing edge into an ignorable back-edge. */
const BACK_EDGE_TARGET_KINDS = new Set<string>(["flow.loop", "flow.wait"])

function isAnnotation(kind: string): boolean {
  return kind.startsWith("annotation.")
}

/**
 * Forward reachability from `from` to `to` over edges whose target is NOT a
 * back-edge kind — the same approximation `topo-sort.isReachable` uses to
 * decide whether an edge into a loop/wait node closes a cycle.
 */
function reachableForward(
  edges: ReadonlyArray<GraphEdgeLike>,
  kindById: ReadonlyMap<string, string>,
  from: string,
  to: string
): boolean {
  if (from === to) return true
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    const targetKind = kindById.get(edge.target)
    if (targetKind !== undefined && BACK_EDGE_TARGET_KINDS.has(targetKind)) continue
    if (!adj.has(edge.source)) adj.set(edge.source, [])
    adj.get(edge.source)!.push(edge.target)
  }
  const visited = new Set<string>([from])
  const stack: string[] = [from]
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

/** All edges minus the authorized back-edges (loop/wait cycle closers). */
function forwardEdgesOf(
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): GraphEdgeLike[] {
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]))
  const forward: GraphEdgeLike[] = []
  for (const edge of edges) {
    const targetKind = kindById.get(edge.target)
    if (
      targetKind !== undefined &&
      BACK_EDGE_TARGET_KINDS.has(targetKind) &&
      reachableForward(edges, kindById, edge.target, edge.source)
    ) {
      continue // authorized back-edge — ignore for upstream computation
    }
    forward.push(edge)
  }
  return forward
}

/** Reverse adjacency (target → sources) over the forward graph. */
function reverseAdjacency(forwardEdges: ReadonlyArray<GraphEdgeLike>): Map<string, string[]> {
  const rev = new Map<string, string[]>()
  for (const edge of forwardEdges) {
    if (!rev.has(edge.target)) rev.set(edge.target, [])
    rev.get(edge.target)!.push(edge.source)
  }
  return rev
}

/**
 * The set of node ids transitively upstream of `nodeId` (excluding the node
 * itself and any annotation nodes). Empty when `nodeId` is unknown.
 */
export function computeUpstreamNodeIds(
  nodeId: string,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): Set<string> {
  const result = new Set<string>()
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]))
  if (!kindById.has(nodeId)) return result

  const rev = reverseAdjacency(forwardEdgesOf(nodes, edges))
  const visited = new Set<string>([nodeId])
  const queue: string[] = [nodeId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const src of rev.get(cur) ?? []) {
      if (visited.has(src)) continue
      visited.add(src)
      queue.push(src)
      const kind = kindById.get(src)
      if (kind !== undefined && !isAnnotation(kind)) result.add(src)
    }
  }
  return result
}

/**
 * Upstream nodes ordered nearest-first with their BFS distance — for display
 * in the variable picker / autocomplete. Excludes the node itself and
 * annotations.
 */
export function upstreamNodesFor(
  nodeId: string,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): UpstreamNode[] {
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]))
  if (!kindById.has(nodeId)) return []

  const rev = reverseAdjacency(forwardEdgesOf(nodes, edges))
  const out: UpstreamNode[] = []
  const visited = new Set<string>([nodeId])
  let frontier: string[] = [nodeId]
  let distance = 1
  while (frontier.length > 0) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const src of rev.get(cur) ?? []) {
        if (visited.has(src)) continue
        visited.add(src)
        next.push(src)
        const kind = kindById.get(src) ?? ""
        if (!isAnnotation(kind)) out.push({ id: src, kind, distance })
      }
    }
    frontier = next
    distance += 1
  }
  return out
}

/**
 * Whether `referencedNodeId` is a legal `$node` reference target from
 * `currentNodeId` — i.e. a distinct, transitively-upstream node.
 */
export function isReferenceInScope(
  currentNodeId: string,
  referencedNodeId: string,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): boolean {
  if (currentNodeId === referencedNodeId) return false
  return computeUpstreamNodeIds(currentNodeId, nodes, edges).has(referencedNodeId)
}
