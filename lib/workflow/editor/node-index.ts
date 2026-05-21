/**
 * Node-index helpers for the workflow editor store.
 *
 * The InspectorPanel selector and several pure helpers (mention expand,
 * quick-action prompts, error explainer) repeatedly need an
 * O(1) `nodeId → RFWorkflowNode` lookup. Doing this with `nodes.find(...)`
 * inside a Zustand `useShallow` selector costs O(N) on *every* store
 * mutation — even mutations that don't touch nodes — because Zustand
 * invokes every subscriber's selector on every `set()`.
 *
 * The index built here is:
 *   • `byId`  nodeId → RFWorkflowNode
 *
 * Cached via a `WeakMap` keyed on the `nodes` array identity, so:
 *   • the index rebuilds automatically on the next access whenever
 *     a store mutation produces a fresh array (Zustand actions copy);
 *   • old array references get garbage-collected together with their
 *     index entries — no manual eviction needed;
 *   • zero changes to mutation sites in the store: simply call the
 *     pure helpers below from any consumer that holds the `nodes`
 *     reference.
 *
 * Mirrors `edge-index.ts` deliberately; keep their shapes aligned so
 * callers that work with both can rely on the same mental model.
 */

import type { RFWorkflowNode } from "./react-flow-converter"

export interface NodeIndex {
  byId: Map<string, RFWorkflowNode>
}

const indexCache: WeakMap<ReadonlyArray<RFWorkflowNode>, NodeIndex> = new WeakMap()

/**
 * Build a fresh node index. Exported for tests and for callers that need
 * to materialise an index outside the WeakMap (e.g. when working with a
 * derived copy of `nodes` that won't outlive the call).
 *
 * When two nodes share the same id (shouldn't happen in practice but
 * guard against it for resilience) the later entry wins — matches the
 * semantics callers get from `new Map(nodes.map((n) => [n.id, n]))`.
 */
export function buildNodeIndex(nodes: ReadonlyArray<RFWorkflowNode>): NodeIndex {
  const byId = new Map<string, RFWorkflowNode>()
  for (const n of nodes) {
    byId.set(n.id, n)
  }
  return { byId }
}

/**
 * Get (or build & cache) the index for a `nodes` array. Pure: callers can
 * call this repeatedly with the same array reference and pay the build
 * cost only once.
 */
export function getNodeIndex(nodes: ReadonlyArray<RFWorkflowNode>): NodeIndex {
  const cached = indexCache.get(nodes)
  if (cached) return cached
  const idx = buildNodeIndex(nodes)
  indexCache.set(nodes, idx)
  return idx
}

/** O(1) lookup by node id. Returns `undefined` if the node isn't present. */
export function getNodeById(
  nodes: ReadonlyArray<RFWorkflowNode>,
  nodeId: string
): RFWorkflowNode | undefined {
  return getNodeIndex(nodes).byId.get(nodeId)
}
