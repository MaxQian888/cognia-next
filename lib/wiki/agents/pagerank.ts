/**
 * Personalized PageRank over a directed module graph.
 *
 * This is the Phase-2 piece the `RepoMapAgent` header always pointed at:
 * Aider-style importance ranking that flows weight toward heavily-depended-upon
 * modules, rather than the size-only heuristic. Pure + deterministic (sorted
 * node iteration, fixed iteration count) so the same graph always yields the
 * same ranks.
 *
 * The graph is `importer → imported` (an edge means the source module imports
 * the target); PageRank therefore concentrates on modules that many others
 * depend on. Dangling nodes (no out-edges) redistribute their mass via the
 * personalization vector, and the returned scores sum to ~1 over all nodes.
 */

export interface PageRankOptions {
  /** Damping factor (probability of following an edge vs. teleporting). */
  damping?: number
  /** Fixed iteration count (power iteration). */
  iterations?: number
  /**
   * Optional teleport/personalization weights per module. Missing modules get
   * an even share of the remaining mass; the vector is normalized internally.
   */
  personalization?: ReadonlyMap<string, number>
}

const DEFAULT_DAMPING = 0.85
const DEFAULT_ITERATIONS = 40

/**
 * Compute PageRank scores for every node reachable in `graph` (both edge
 * sources and edge targets). Returns a map of node → score (scores sum to ~1).
 */
export function personalizedPageRank(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  options: PageRankOptions = {}
): Map<string, number> {
  const damping = clamp(options.damping ?? DEFAULT_DAMPING, 0, 0.99)
  const iterations = Math.max(1, options.iterations ?? DEFAULT_ITERATIONS)

  // Collect every node (edge sources AND targets) in a stable, sorted order.
  const nodeSet = new Set<string>()
  for (const [src, targets] of graph) {
    nodeSet.add(src)
    for (const t of targets) nodeSet.add(t)
  }
  const nodes = [...nodeSet].sort()
  const n = nodes.length
  const scores = new Map<string, number>()
  if (n === 0) return scores

  // Personalization vector (teleport distribution), normalized to sum 1.
  const teleport = buildTeleport(nodes, options.personalization)

  // Out-degree + reverse adjacency (target → [{ src, outDeg }]).
  const outDeg = new Map<string, number>()
  const incoming = new Map<string, string[]>()
  for (const node of nodes) incoming.set(node, [])
  for (const [src, targets] of graph) {
    const filtered = [...targets].filter((t) => t !== src && nodeSet.has(t))
    outDeg.set(src, filtered.length)
    for (const t of filtered) incoming.get(t)!.push(src)
  }

  // Power iteration starting from the teleport distribution.
  let pr = new Map(nodes.map((node) => [node, teleport.get(node)!]))
  for (let iter = 0; iter < iterations; iter++) {
    // Mass held by dangling nodes (no out-edges) is redistributed via teleport.
    let danglingMass = 0
    for (const node of nodes) {
      if ((outDeg.get(node) ?? 0) === 0) danglingMass += pr.get(node)!
    }
    const next = new Map<string, number>()
    for (const node of nodes) {
      let incomingMass = 0
      for (const src of incoming.get(node)!) {
        incomingMass += pr.get(src)! / outDeg.get(src)!
      }
      const teleportShare = teleport.get(node)!
      const score =
        (1 - damping) * teleportShare + damping * (incomingMass + danglingMass * teleportShare)
      next.set(node, score)
    }
    pr = next
  }

  return pr
}

/**
 * Normalize a score map to 0..1 by dividing by the maximum (matches
 * `ModuleStat.pageRank`'s 0..1 contract). Empty/all-zero input → all zeros.
 */
export function normalizeScores(scores: ReadonlyMap<string, number>): Map<string, number> {
  let max = 0
  for (const v of scores.values()) if (v > max) max = v
  const out = new Map<string, number>()
  for (const [k, v] of scores) out.set(k, max > 0 ? v / max : 0)
  return out
}

function buildTeleport(
  nodes: readonly string[],
  personalization?: ReadonlyMap<string, number>
): Map<string, number> {
  const teleport = new Map<string, number>()
  if (personalization && personalization.size > 0) {
    let sum = 0
    for (const node of nodes) sum += Math.max(0, personalization.get(node) ?? 0)
    if (sum > 0) {
      for (const node of nodes) {
        teleport.set(node, Math.max(0, personalization.get(node) ?? 0) / sum)
      }
      return teleport
    }
  }
  const even = 1 / nodes.length
  for (const node of nodes) teleport.set(node, even)
  return teleport
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}
