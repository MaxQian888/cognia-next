/**
 * Density clustering over embedding vectors — DBSCAN with an adaptive radius.
 *
 * `clusterBySimilarity` (`./embedding-utils`) is a greedy single-pass threshold
 * grouping: the first point claims every neighbour above a fixed similarity,
 * so the result depends on input order and chains never form. Near-duplicate
 * detection over a corpus of unknown density needs the opposite properties —
 * order-independent membership and a radius derived from the data — which is
 * what DBSCAN with a k-distance "knee" gives. Ported from ai-memory's
 * `cold_cluster.rs`.
 *
 * Pure and dependency-free: no `ai` import, safe for any bundle.
 */

/**
 * Cosine distance in [0, 2]. Mismatched lengths, empty vectors and zero
 * vectors read as 1 (orthogonal) rather than throwing: a corrupt vector must
 * degrade to "not a duplicate", never crash a maintenance pass.
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 1
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 1
  const distance = 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB))
  return Math.min(2, Math.max(0, distance))
}

/**
 * Radius from the knee of the sorted k-distance curve ("kneedle"): for every
 * point take the distance to its k-th nearest neighbour (self excluded), sort
 * ascending, and pick the value farthest from the chord joining the first and
 * last points. Clamped to `[0, maxEps]`.
 *
 * Returns `null` when there are not enough points to define a k-th neighbour
 * (`k === 0` or `n <= k`).
 */
export function adaptiveEps(
  points: readonly (readonly number[])[],
  k: number,
  maxEps: number
): number | null {
  const n = points.length
  if (k <= 0 || n <= k) return null
  const kDistances: number[] = []
  for (let i = 0; i < n; i++) {
    const distances: number[] = []
    for (let j = 0; j < n; j++) {
      if (i !== j) distances.push(cosineDistance(points[i], points[j]))
    }
    distances.sort((left, right) => left - right)
    kDistances.push(distances[k - 1])
  }
  kDistances.sort((left, right) => left - right)
  const clamp = (value: number) => Math.min(Math.max(0, maxEps), Math.max(0, value))
  if (n <= 2) return clamp(kDistances[n - 1])

  const x0 = 0
  const y0 = kDistances[0]
  const x1 = n - 1
  const y1 = kDistances[n - 1]
  const chord = Math.hypot(x1 - x0, y1 - y0)
  if (chord === 0) return clamp(kDistances[n - 1])

  let knee = kDistances[n - 1]
  let best = -1
  for (let i = 0; i < n; i++) {
    const distance = Math.abs((y1 - y0) * i - (x1 - x0) * kDistances[i] + x1 * y0 - y1 * x0) / chord
    if (distance > best) {
      best = distance
      knee = kDistances[i]
    }
  }
  return clamp(knee)
}

/**
 * DBSCAN. A point is core when at least `minPts` points (itself included) lie
 * within `eps`; clusters grow breadth-first from core points; border points
 * join the first cluster that reaches them but do not expand it; noise is
 * omitted. Iteration is in index order, so the result is deterministic.
 *
 * Returns clusters as arrays of point indices.
 */
export function dbscan(
  points: readonly (readonly number[])[],
  eps: number,
  minPts: number
): number[][] {
  const n = points.length
  const UNVISITED = -2
  const NOISE = -1
  const labels = new Array<number>(n).fill(UNVISITED)
  const clusters: number[][] = []

  const regionQuery = (index: number): number[] => {
    const neighbours: number[] = []
    for (let j = 0; j < n; j++) {
      if (cosineDistance(points[index], points[j]) <= eps) neighbours.push(j)
    }
    return neighbours
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] !== UNVISITED) continue
    const neighbours = regionQuery(i)
    if (neighbours.length < minPts) {
      labels[i] = NOISE
      continue
    }
    const clusterId = clusters.length
    const members = [i]
    labels[i] = clusterId
    const queue = neighbours.filter((j) => j !== i)
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q]
      if (labels[j] === NOISE) {
        // Border point: attach, never expand from it.
        labels[j] = clusterId
        members.push(j)
        continue
      }
      if (labels[j] !== UNVISITED) continue
      labels[j] = clusterId
      members.push(j)
      const expansion = regionQuery(j)
      if (expansion.length >= minPts) {
        for (const next of expansion) {
          if (labels[next] === UNVISITED || labels[next] === NOISE) queue.push(next)
        }
      }
    }
    clusters.push(members.sort((left, right) => left - right))
  }
  return clusters
}
