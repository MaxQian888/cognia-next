// Graph traversals over a code-graph store.
//
// Pure over the store interface (works against store-memory or store-sqlite):
//   - callers(id)  : transitive incoming `calls`/`references` edges
//   - callees(id)  : transitive outgoing `calls`/`references` edges
//   - impact(id)   : blast radius — reverse closure over calls/imports/extends/
//                    implements (who breaks if `id` changes)
//   - randomWalkWithRestart(seeds): connectivity relevance for context ranking
//
// All BFS traversals carry a visited-set so cycles terminate, and a depth cap.

import type { CodeGraphStore, GraphNode } from "./store-memory.ts"

/** The store reads a traversal needs. */
export type GraphReader = Pick<CodeGraphStore, "edgesFrom" | "edgesTo" | "getNode" | "allEdges">

const CALL_KINDS: ReadonlySet<string> = new Set(["calls", "references"])
const IMPACT_KINDS: ReadonlySet<string> = new Set([
  "calls",
  "references",
  "imports",
  "extends",
  "implements",
])

const DEFAULT_DEPTH = 3

/**
 * Hard cap on nodes returned by one BFS traversal. Exported because a result
 * that reaches this cap is a FLOOR, not a total — `codegraph_impact` must not
 * present a capped count as the true blast radius.
 */
export const GRAPH_TRAVERSAL_MAX = 500
const MAX_RESULTS = GRAPH_TRAVERSAL_MAX

/** A node a traversal reached, at its hop distance from the start. */
export interface Reached {
  id: string
  distance: number
  node: GraphNode | null
}

/** Breadth-first closure from `startId` following edges in `direction`. */
function bfs(
  store: GraphReader,
  startId: string,
  {
    direction,
    kinds,
    depth = DEFAULT_DEPTH,
    max = MAX_RESULTS,
  }: { direction: "in" | "out"; kinds: ReadonlySet<string>; depth?: number; max?: number }
): Reached[] {
  const visited = new Set([startId])
  const out: Reached[] = []
  let frontier = [startId]
  const cap = Math.max(0, depth)
  for (let dist = 1; dist <= cap && frontier.length > 0; dist++) {
    const next: string[] = []
    for (const id of frontier) {
      const edges = direction === "in" ? store.edgesTo(id) : store.edgesFrom(id)
      for (const e of edges) {
        if (!kinds.has(e.kind)) continue
        const neighbour = direction === "in" ? e.source : e.target
        if (!neighbour || visited.has(neighbour)) continue
        visited.add(neighbour)
        out.push({ id: neighbour, distance: dist, node: store.getNode(neighbour) })
        next.push(neighbour)
        if (out.length >= max) return out
      }
    }
    frontier = next
  }
  return out
}

/** Who calls / references `id` (transitively). */
export function callers(store: GraphReader, id: string, depth = DEFAULT_DEPTH): Reached[] {
  return bfs(store, id, { direction: "in", kinds: CALL_KINDS, depth })
}

/** What `id` calls / references (transitively). */
export function callees(store: GraphReader, id: string, depth = DEFAULT_DEPTH): Reached[] {
  return bfs(store, id, { direction: "out", kinds: CALL_KINDS, depth })
}

/** Blast radius: everything that transitively depends on `id`. */
export function impact(store: GraphReader, id: string, depth = DEFAULT_DEPTH): Reached[] {
  return bfs(store, id, { direction: "in", kinds: IMPACT_KINDS, depth })
}

/**
 * Random-Walk-with-Restart relevance scores from `seeds` over the call/
 * reference graph. Connectivity-based ranking: symbols structurally close to
 * the seeds score high. Treats edges as undirected for relevance (a callee is
 * as relevant as a caller). Returns nodeId → score (sums to ~1 over reached
 * nodes).
 */
export function randomWalkWithRestart(
  store: GraphReader,
  seeds: readonly string[] | null | undefined,
  opts: { restart?: number; iterations?: number; kinds?: ReadonlySet<string> } = {}
): Map<string, number> {
  const restart = clamp(opts.restart ?? 0.15, 0.01, 0.99)
  const iterations = Math.max(1, opts.iterations ?? 25)
  const kinds = opts.kinds ?? IMPACT_KINDS
  const seedSet = (seeds ?? []).filter((s) => store.getNode(s))
  const scores = new Map<string, number>()
  if (seedSet.length === 0) return scores

  // Build an undirected adjacency over the relevant edge kinds.
  const adj = new Map<string, Set<string>>()
  const addEdge = (a: string, b: string) => {
    if (!a || !b) return
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }
  for (const e of store.allEdges()) {
    if (!kinds.has(e.kind)) continue
    addEdge(e.source, e.target)
    addEdge(e.target, e.source)
  }

  const seedMass = 1 / seedSet.length
  let p = new Map<string, number>(seedSet.map((s) => [s, seedMass]))

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>()
    // Restart mass back to seeds.
    for (const s of seedSet) next.set(s, (next.get(s) ?? 0) + restart * seedMass)
    // Spread (1-restart) along edges.
    for (const [node, mass] of p) {
      const neighbours = adj.get(node)
      if (!neighbours || neighbours.size === 0) {
        // Dangling node: return its mass to the seeds.
        for (const s of seedSet) next.set(s, (next.get(s) ?? 0) + (1 - restart) * mass * seedMass)
        continue
      }
      const share = ((1 - restart) * mass) / neighbours.size
      for (const nb of neighbours) next.set(nb, (next.get(nb) ?? 0) + share)
    }
    p = next
  }
  for (const [k, v] of p) scores.set(k, v)
  return scores
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export const __TESTING__ = { CALL_KINDS, IMPACT_KINDS, DEFAULT_DEPTH }
