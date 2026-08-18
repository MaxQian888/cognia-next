/**
 * Turn a `ResolutionResult` into a React Flow graph.
 *
 * Split out from the component and kept pure so the layout — which is where all
 * the meaning lives — can be asserted without mounting React Flow, which does
 * not measure meaningfully in jsdom.
 *
 * The resolver already computes everything this draws: a Kahn topological sort
 * (`installOrder`) and pairwise conflicts with the constraints that caused them.
 * The old view rendered that as four flat lists, which threw away the one thing
 * a graph is for — showing that B must be installed before C because A needs
 * both, and that two plugins disagree about the *same* dependency.
 *
 * Layout is by topological rank, not by list position, so an edge always points
 * from a dependent to its dependency and never backwards.
 */

import type { DependencyConflict, ResolutionResult } from "@/lib/plugin/package/dependency-resolver"

export type DependencyNodeKind = "root" | "resolved" | "unsatisfied" | "missing" | "conflicted"

export interface DependencyGraphNode {
  id: string
  label: string
  version?: string
  kind: DependencyNodeKind
  /** Topological rank; 0 is the root plugin. */
  rank: number
  position: { x: number; y: number }
}

export interface DependencyGraphEdge {
  id: string
  source: string
  target: string
  /** The version constraint the dependent declared, when known. */
  label?: string
  conflicted: boolean
}

export interface DependencyGraphModel {
  nodes: DependencyGraphNode[]
  edges: DependencyGraphEdge[]
  height: number
}

const RANK_HEIGHT = 96
const NODE_SPACING_X = 190
const TOP_PADDING = 24

/**
 * Rank each dependency by its position in the resolver's install order.
 *
 * `installOrder` is a topological sort, so anything earlier in it is depended
 * upon by something later. Ranking by index and then compacting gives columns
 * where every edge runs downward. Dependencies absent from the order (the
 * missing ones — they were never installable) go in a final rank of their own.
 */
function rankOf(result: ResolutionResult): Map<string, number> {
  const ranks = new Map<string, number>()
  result.installOrder.forEach((id, index) => ranks.set(id, index + 1))
  let next = result.installOrder.length + 1
  for (const id of result.missing) {
    if (!ranks.has(id)) ranks.set(id, next)
  }
  if (result.missing.length > 0) next += 1
  for (const dep of result.resolved) {
    if (!ranks.has(dep.id)) ranks.set(dep.id, next)
  }
  return ranks
}

function conflictedIds(conflicts: readonly DependencyConflict[]): Set<string> {
  return new Set(conflicts.map((conflict) => conflict.dependencyId))
}

export function buildDependencyGraph(
  rootId: string,
  result: ResolutionResult
): DependencyGraphModel {
  const conflicted = conflictedIds(result.conflicts)
  const ranks = rankOf(result)

  const nodes: DependencyGraphNode[] = [
    {
      id: rootId,
      label: rootId,
      kind: "root",
      rank: 0,
      position: { x: 0, y: TOP_PADDING },
    },
  ]

  for (const dep of result.resolved) {
    nodes.push({
      id: dep.id,
      label: dep.id,
      version: dep.version,
      kind: conflicted.has(dep.id) ? "conflicted" : dep.satisfies ? "resolved" : "unsatisfied",
      rank: ranks.get(dep.id) ?? 1,
      position: { x: 0, y: 0 },
    })
  }

  for (const id of result.missing) {
    // A dependency can be both missing and conflicted; missing is the stronger
    // statement (there is nothing to install), so it wins the label.
    nodes.push({
      id,
      label: id,
      kind: "missing",
      rank: ranks.get(id) ?? 1,
      position: { x: 0, y: 0 },
    })
  }

  // Lay out each rank as a row, centred by count.
  const byRank = new Map<number, DependencyGraphNode[]>()
  for (const node of nodes) {
    const list = byRank.get(node.rank) ?? []
    list.push(node)
    byRank.set(node.rank, list)
  }
  for (const [rank, row] of byRank) {
    const width = (row.length - 1) * NODE_SPACING_X
    row.forEach((node, index) => {
      node.position = {
        x: index * NODE_SPACING_X - width / 2,
        y: TOP_PADDING + rank * RANK_HEIGHT,
      }
    })
  }

  const edges: DependencyGraphEdge[] = []
  const seenEdges = new Set<string>()

  // The root depends on everything the resolver reported for it.
  for (const dep of result.resolved) {
    const id = `${rootId}->${dep.id}`
    if (seenEdges.has(id)) continue
    seenEdges.add(id)
    edges.push({
      id,
      source: rootId,
      target: dep.id,
      label: dep.constraint,
      conflicted: conflicted.has(dep.id),
    })
  }
  for (const missing of result.missing) {
    const id = `${rootId}->${missing}`
    if (seenEdges.has(id)) continue
    seenEdges.add(id)
    edges.push({ id, source: rootId, target: missing, conflicted: true })
  }

  // Conflicts name every plugin that demanded the dependency and with what
  // constraint. Drawing those edges is the point: a conflict is a *disagreement
  // between two dependents*, which four flat lists could never show.
  for (const conflict of result.conflicts) {
    for (const requirer of conflict.requiredBy) {
      const id = `${requirer.pluginId}->${conflict.dependencyId}`
      if (seenEdges.has(id)) continue
      seenEdges.add(id)
      if (!nodes.some((node) => node.id === requirer.pluginId)) {
        nodes.push({
          id: requirer.pluginId,
          label: requirer.pluginId,
          kind: "resolved",
          rank: 1,
          position: { x: 0, y: TOP_PADDING + RANK_HEIGHT },
        })
      }
      edges.push({
        id,
        source: requirer.pluginId,
        target: conflict.dependencyId,
        label: requirer.constraint,
        conflicted: true,
      })
    }
  }

  const maxRank = Math.max(0, ...nodes.map((node) => node.rank))
  return { nodes, edges, height: TOP_PADDING * 2 + (maxRank + 1) * RANK_HEIGHT }
}
