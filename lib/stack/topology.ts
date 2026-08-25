/**
 * Ordering a set of nodes so nothing is visited before what it depends on.
 *
 * Lifted out of `lib/ai/agent/team/delivery-graph`, where it was the only piece
 * of that file with no Agent Team in it. A stack is a dependency chain, a
 * multi-repository delivery graph is a dependency DAG, and the ordering rule —
 * dependencies first, ties broken deterministically — is the same in both.
 *
 * Deterministic on purpose. The tie-break is `order` then `tieBreaker`, so two
 * runs over the same set produce the same sequence: a publish that creates pull
 * requests in a different order each time is impossible to reason about when it
 * fails halfway.
 */

export interface TopologicalNode {
  id: string
  /** Ids of nodes that must come first. */
  dependsOn: readonly string[]
  /** Primary tie-break among nodes that are ready at the same time. */
  order: number
  /** Secondary tie-break — a repository id, a branch name, anything stable. */
  tieBreaker?: string
}

export class TopologyError extends Error {
  constructor(
    message: string,
    /** The node ids involved, for a message that names them. */
    readonly nodes: readonly string[]
  ) {
    super(message)
    this.name = "TopologyError"
  }
}

/**
 * Every node, dependencies first.
 *
 * Throws rather than dropping: an unknown dependency and a cycle are both
 * "the graph is not what the caller thinks it is", and silently emitting a
 * partial order would publish half a stack.
 */
export function topologicalOrder<T extends TopologicalNode>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const unknown: string[] = []
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) unknown.push(dependency)
    }
  }
  if (unknown.length) {
    throw new TopologyError(`Unknown dependency: ${[...new Set(unknown)].join(", ")}`, unknown)
  }

  const complete = new Set<string>()
  const output: T[] = []
  while (output.length < nodes.length) {
    const ready = nodes
      .filter((node) => !complete.has(node.id) && node.dependsOn.every((id) => complete.has(id)))
      .sort(
        (left, right) =>
          left.order - right.order ||
          (left.tieBreaker ?? "").localeCompare(right.tieBreaker ?? "") ||
          left.id.localeCompare(right.id)
      )
    if (ready.length === 0) {
      const stuck = nodes.filter((node) => !complete.has(node.id)).map((node) => node.id)
      throw new TopologyError(`Dependency cycle among: ${stuck.join(", ")}`, stuck)
    }
    for (const node of ready) {
      complete.add(node.id)
      output.push(node)
    }
  }
  return output
}

/**
 * A straight chain, bottom first, or null when the nodes do not form one.
 *
 * A stack is the special case of a DAG where every node has exactly one
 * dependency and nothing shares a dependency. Callers that specifically need a
 * stack — restacking, submitting a chain of pull requests — need to know they
 * have one, because a branching graph restacked as if it were a line silently
 * drops a sibling.
 */
export function linearChain<T extends TopologicalNode>(nodes: readonly T[]): T[] | null {
  if (nodes.length === 0) return []
  const dependants = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.dependsOn.length > 1) return null
    for (const dependency of node.dependsOn) {
      dependants.set(dependency, [...(dependants.get(dependency) ?? []), node.id])
    }
  }
  if ([...dependants.values()].some((children) => children.length > 1)) return null
  const roots = nodes.filter((node) => node.dependsOn.length === 0)
  if (roots.length !== 1) return null
  const ordered = topologicalOrder(nodes)
  return ordered.length === nodes.length ? ordered : null
}
