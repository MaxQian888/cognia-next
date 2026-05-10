/**
 * Pure clipboard primitives for the workflow editor — clone with offset,
 * remap ids, filter dangling edges, plus a stable JSON envelope for system-
 * clipboard round-trips.
 *
 * All inputs are React Flow's `RFWorkflowNode` / `RFWorkflowEdge` arrays
 * (the same shape the store carries), so the canvas can pass its current
 * arrays in without conversion.
 */

import { nanoid } from "nanoid"
import type { RFWorkflowEdge, RFWorkflowNode } from "./react-flow-converter"

/** Distinct envelope marker so we can tell our own clipboard payloads apart
 *  from arbitrary text the user might paste. */
export const CLIPBOARD_FORMAT = "cognia.workflow.clipboard.v1" as const

export interface ClipboardEnvelope {
  /** Discriminator. */
  format: typeof CLIPBOARD_FORMAT
  /** Schema version for future evolutions. */
  version: 1
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
}

export interface CloneResult {
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
  /** Map from old id → new id; useful for the canvas to select pasted items. */
  idMap: Map<string, string>
}

const newNodeId = () => "n_" + nanoid(8)
const newEdgeId = () => "e_" + nanoid(8)

/**
 * Clone the given subset of nodes (by id) plus the edges that wholly live
 * inside the subset (both endpoints selected). Edges that dangle out of
 * the subset are dropped — pasting only-some-nodes shouldn't carry over
 * connections to nodes that aren't being pasted.
 *
 * Positions are offset by `offset` (default `{x:24,y:24}`) so the user
 * visually sees the new copies separately from the originals.
 */
export function cloneNodesAndEdges(
  allNodes: ReadonlyArray<RFWorkflowNode>,
  allEdges: ReadonlyArray<RFWorkflowEdge>,
  selectedIds: ReadonlyArray<string>,
  offset: { x: number; y: number } = { x: 24, y: 24 }
): CloneResult {
  const selectedSet = new Set(selectedIds)
  const idMap = new Map<string, string>()
  const nodes: RFWorkflowNode[] = []
  for (const n of allNodes) {
    if (!selectedSet.has(n.id)) continue
    const fresh = newNodeId()
    idMap.set(n.id, fresh)
    nodes.push({
      ...n,
      id: fresh,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      // Drop runtime-only state that should NEVER carry across paste.
      selected: false,
      dragging: false,
    })
  }
  const edges: RFWorkflowEdge[] = []
  for (const e of allEdges) {
    if (!selectedSet.has(e.source) || !selectedSet.has(e.target)) continue
    const newSource = idMap.get(e.source)
    const newTarget = idMap.get(e.target)
    if (!newSource || !newTarget) continue
    edges.push({
      ...e,
      id: newEdgeId(),
      source: newSource,
      target: newTarget,
      selected: false,
    })
  }
  return { nodes, edges, idMap }
}

/**
 * Build a clipboard envelope ready to write to the system clipboard. The
 * envelope is JSON-serialisable and small (positions + data only).
 */
export function buildClipboardEnvelope(
  nodes: ReadonlyArray<RFWorkflowNode>,
  edges: ReadonlyArray<RFWorkflowEdge>,
  selectedIds: ReadonlyArray<string>
): ClipboardEnvelope {
  const selectedSet = new Set(selectedIds)
  const filteredNodes = nodes.filter((n) => selectedSet.has(n.id))
  const filteredEdges = edges.filter((e) => selectedSet.has(e.source) && selectedSet.has(e.target))
  return {
    format: CLIPBOARD_FORMAT,
    version: 1,
    nodes: filteredNodes.map((n) => ({ ...n, selected: false, dragging: false })),
    edges: filteredEdges.map((e) => ({ ...e, selected: false })),
  }
}

/** Stringify for a `navigator.clipboard.writeText` call. */
export function serializeClipboard(envelope: ClipboardEnvelope): string {
  return JSON.stringify(envelope)
}

/**
 * Parse text back into an envelope. Returns null when the text is missing,
 * malformed, or doesn't carry our format marker — so the canvas can
 * silently no-op on irrelevant pastes (e.g., text paste while the canvas
 * happens to have focus).
 */
export function parseClipboard(text: string | null | undefined): ClipboardEnvelope | null {
  if (!text || typeof text !== "string") return null
  try {
    const parsed = JSON.parse(text) as Partial<ClipboardEnvelope>
    if (parsed.format !== CLIPBOARD_FORMAT) return null
    if (parsed.version !== 1) return null
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return parsed as ClipboardEnvelope
  } catch {
    return null
  }
}

/**
 * Hydrate an envelope into fresh React-Flow nodes/edges with NEW ids. Mirrors
 * `cloneNodesAndEdges` but works on a serialised input. The same `offset` is
 * applied so multiple Ctrl+V calls in a row visibly cascade.
 */
export function rehydrateFromEnvelope(
  envelope: ClipboardEnvelope,
  offset: { x: number; y: number } = { x: 24, y: 24 }
): CloneResult {
  return cloneNodesAndEdges(
    envelope.nodes,
    envelope.edges,
    envelope.nodes.map((n) => n.id),
    offset
  )
}

/**
 * Compute the bounding box of a set of nodes. Used by the "wrap selection
 * in group annotation" action so the inserted group frame fits its
 * children with a small inset padding.
 */
export function selectionBounds(
  nodes: ReadonlyArray<RFWorkflowNode>,
  selectedIds: ReadonlyArray<string>,
  defaultNodeSize: { width: number; height: number } = { width: 240, height: 80 }
): { x: number; y: number; width: number; height: number } | null {
  const selectedSet = new Set(selectedIds)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (const n of nodes) {
    if (!selectedSet.has(n.id)) continue
    count++
    const w = n.width ?? defaultNodeSize.width
    const h = n.height ?? defaultNodeSize.height
    if (n.position.x < minX) minX = n.position.x
    if (n.position.y < minY) minY = n.position.y
    if (n.position.x + w > maxX) maxX = n.position.x + w
    if (n.position.y + h > maxY) maxY = n.position.y + h
  }
  if (count === 0) return null
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}
