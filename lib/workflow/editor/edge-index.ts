/**
 * Edge-index helpers for the workflow editor store.
 *
 * Workflow-node renderers and the connection-drag overlay frequently need
 * to answer questions like "does any edge leave this node going to X?"
 * (cycle check) and "which edge has id Y?" (hovered-endpoint highlight).
 * Doing this with `edges.some(...)` / `edges.find(...)` on every render
 * costs O(E) per query × N nodes during interaction, which dominates
 * canvas perf once graphs grow past ~100 edges.
 *
 * The index built here is:
 *   • `byId`              edgeId           → RFWorkflowEdge
 *   • `outgoingByNodeId`  source nodeId    → edgeId[]
 *   • `incomingByNodeId`  target nodeId    → edgeId[]
 *
 * Cached via a `WeakMap` keyed on the `edges` array identity, so:
 *   • the index rebuilds automatically on the next access whenever
 *     a store mutation produces a fresh array (Zustand actions copy);
 *   • old array references get garbage-collected together with their
 *     index entries — no manual eviction needed;
 *   • zero changes to mutation sites in the store: simply call the
 *     pure helpers below from any consumer that holds the `edges`
 *     reference.
 */

import type { RFWorkflowEdge } from "./react-flow-converter"

export interface EdgeIndex {
  byId: Map<string, RFWorkflowEdge>
  outgoingByNodeId: Map<string, string[]>
  incomingByNodeId: Map<string, string[]>
}

const indexCache: WeakMap<ReadonlyArray<RFWorkflowEdge>, EdgeIndex> = new WeakMap()

/**
 * Build a fresh edge index. Exported for tests and for callers that need
 * to materialise an index outside the WeakMap (e.g. when working with a
 * derived copy of `edges` that won't outlive the call).
 */
export function buildEdgeIndex(edges: ReadonlyArray<RFWorkflowEdge>): EdgeIndex {
  const byId = new Map<string, RFWorkflowEdge>()
  const outgoingByNodeId = new Map<string, string[]>()
  const incomingByNodeId = new Map<string, string[]>()
  for (const e of edges) {
    byId.set(e.id, e)
    const out = outgoingByNodeId.get(e.source)
    if (out) out.push(e.id)
    else outgoingByNodeId.set(e.source, [e.id])
    const inc = incomingByNodeId.get(e.target)
    if (inc) inc.push(e.id)
    else incomingByNodeId.set(e.target, [e.id])
  }
  return { byId, outgoingByNodeId, incomingByNodeId }
}

/**
 * Get (or build & cache) the index for an `edges` array. Pure: callers can
 * call this repeatedly with the same array reference and pay the build
 * cost only once.
 */
export function getEdgeIndex(edges: ReadonlyArray<RFWorkflowEdge>): EdgeIndex {
  const cached = indexCache.get(edges)
  if (cached) return cached
  const idx = buildEdgeIndex(edges)
  indexCache.set(edges, idx)
  return idx
}

/** O(1) lookup by edge id. Returns `undefined` if the edge isn't present. */
export function getEdgeById(
  edges: ReadonlyArray<RFWorkflowEdge>,
  edgeId: string
): RFWorkflowEdge | undefined {
  return getEdgeIndex(edges).byId.get(edgeId)
}

/**
 * O(1) lookup of edge ids leaving `nodeId` (source). Returns an empty
 * array if the node has no outgoing edges. The array is the same
 * reference stored in the cached index — do NOT mutate it; treat as
 * `ReadonlyArray<string>`.
 */
export function getOutgoingEdgeIds(
  edges: ReadonlyArray<RFWorkflowEdge>,
  nodeId: string
): ReadonlyArray<string> {
  return getEdgeIndex(edges).outgoingByNodeId.get(nodeId) ?? EMPTY_ID_ARRAY
}

/**
 * O(1) lookup of edge ids arriving at `nodeId` (target). Same array-
 * mutation caveat as `getOutgoingEdgeIds`.
 */
export function getIncomingEdgeIds(
  edges: ReadonlyArray<RFWorkflowEdge>,
  nodeId: string
): ReadonlyArray<string> {
  return getEdgeIndex(edges).incomingByNodeId.get(nodeId) ?? EMPTY_ID_ARRAY
}

/**
 * Convenience: does any edge run `from` → `to`? Used by the connection-
 * drag preview to flag would-be cycles cheaply.
 */
export function hasEdgeBetween(
  edges: ReadonlyArray<RFWorkflowEdge>,
  from: string,
  to: string
): boolean {
  const ids = getOutgoingEdgeIds(edges, from)
  if (ids.length === 0) return false
  const byId = getEdgeIndex(edges).byId
  for (const id of ids) {
    const e = byId.get(id)
    if (e && e.target === to) return true
  }
  return false
}

// Single shared empty array so we never allocate per-call when a node has
// no edges in the requested direction.
const EMPTY_ID_ARRAY: ReadonlyArray<string> = Object.freeze([])
