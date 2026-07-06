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

const CALL_KINDS = new Set(["calls", "references"])
const IMPACT_KINDS = new Set(["calls", "references", "imports", "extends", "implements"])

const DEFAULT_DEPTH = 3
const MAX_RESULTS = 500

/**
 * @typedef {{ id: string, distance: number, node: object|null }} Reached
 */

/**
 * Breadth-first closure from `startId` following edges in `direction`.
 * @param {object} store
 * @param {string} startId
 * @param {{ direction: "in"|"out", kinds: Set<string>, depth?: number, max?: number }} opts
 * @returns {Reached[]}
 */
function bfs(store, startId, { direction, kinds, depth = DEFAULT_DEPTH, max = MAX_RESULTS }) {
  const visited = new Set([startId])
  const out = []
  let frontier = [startId]
  const cap = Math.max(0, depth)
  for (let dist = 1; dist <= cap && frontier.length > 0; dist++) {
    const next = []
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
export function callers(store, id, depth = DEFAULT_DEPTH) {
  return bfs(store, id, { direction: "in", kinds: CALL_KINDS, depth })
}

/** What `id` calls / references (transitively). */
export function callees(store, id, depth = DEFAULT_DEPTH) {
  return bfs(store, id, { direction: "out", kinds: CALL_KINDS, depth })
}

/** Blast radius: everything that transitively depends on `id`. */
export function impact(store, id, depth = DEFAULT_DEPTH) {
  return bfs(store, id, { direction: "in", kinds: IMPACT_KINDS, depth })
}

/**
 * Random-Walk-with-Restart relevance scores from `seeds` over the call/
 * reference graph. Connectivity-based ranking: symbols structurally close to
 * the seeds score high. Treats edges as undirected for relevance (a callee is
 * as relevant as a caller).
 *
 * @param {object} store
 * @param {string[]} seeds
 * @param {{ restart?: number, iterations?: number, kinds?: Set<string> }} [opts]
 * @returns {Map<string, number>}  nodeId → score (sums to ~1 over reached nodes)
 */
export function randomWalkWithRestart(store, seeds, opts = {}) {
  const restart = clamp(opts.restart ?? 0.15, 0.01, 0.99)
  const iterations = Math.max(1, opts.iterations ?? 25)
  const kinds = opts.kinds ?? IMPACT_KINDS
  const seedSet = (seeds ?? []).filter((s) => store.getNode(s))
  const scores = new Map()
  if (seedSet.length === 0) return scores

  // Build an undirected adjacency over the relevant edge kinds.
  /** @type {Map<string, Set<string>>} */
  const adj = new Map()
  const addEdge = (a, b) => {
    if (!a || !b) return
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a).add(b)
  }
  for (const e of store.allEdges()) {
    if (!kinds.has(e.kind)) continue
    addEdge(e.source, e.target)
    addEdge(e.target, e.source)
  }

  const seedMass = 1 / seedSet.length
  /** @type {Map<string, number>} */
  let p = new Map(seedSet.map((s) => [s, seedMass]))

  for (let i = 0; i < iterations; i++) {
    /** @type {Map<string, number>} */
    const next = new Map()
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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

export const __TESTING__ = { CALL_KINDS, IMPACT_KINDS, DEFAULT_DEPTH }
