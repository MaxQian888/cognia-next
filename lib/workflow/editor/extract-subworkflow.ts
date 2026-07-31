/**
 * Pure planner for "extract selection to a sub-workflow" (C5). Partitions the
 * edges around a selected node set into:
 *   • internal   — both endpoints selected (move into the child workflow);
 *   • inbound    — an external node → a selected node (rewire to the new
 *                  `flow.subworkflow` node on the parent canvas);
 *   • outbound   — a selected node → an external node (rewire from the new node).
 * Also returns the centroid of the selection for placing the replacement node.
 *
 * The caller builds the child workflow from the selected subset (converting +
 * regenerating ids + injecting a trigger) and applies the rewiring via the
 * store's `replaceSelectionWithNode`.
 */

export interface ExtractionEdgeLike {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface ExtractionNodeLike {
  id: string
  position: { x: number; y: number }
}

export interface ExtractionPlan {
  selectedIds: string[]
  internalEdgeIds: string[]
  /** External → selected: rewire to point at the new subworkflow node. */
  inbound: Array<{ edgeId: string; externalSource: string; sourceHandle?: string }>
  /** Selected → external: rewire to originate from the new subworkflow node. */
  outbound: Array<{ edgeId: string; externalTarget: string; targetHandle?: string }>
  /** Centroid of the selection — where to drop the replacement node. */
  center: { x: number; y: number }
}

export function planExtraction(
  selectedIds: ReadonlyArray<string>,
  nodes: ReadonlyArray<ExtractionNodeLike>,
  edges: ReadonlyArray<ExtractionEdgeLike>
): ExtractionPlan | null {
  const selected = new Set(selectedIds)
  if (selected.size === 0) return null

  const internalEdgeIds: string[] = []
  const inbound: ExtractionPlan["inbound"] = []
  const outbound: ExtractionPlan["outbound"] = []
  for (const edge of edges) {
    const sIn = selected.has(edge.source)
    const tIn = selected.has(edge.target)
    if (sIn && tIn) {
      internalEdgeIds.push(edge.id)
    } else if (!sIn && tIn) {
      inbound.push({
        edgeId: edge.id,
        externalSource: edge.source,
        sourceHandle: edge.sourceHandle ?? undefined,
      })
    } else if (sIn && !tIn) {
      outbound.push({
        edgeId: edge.id,
        externalTarget: edge.target,
        targetHandle: edge.targetHandle ?? undefined,
      })
    }
  }

  let sumX = 0
  let sumY = 0
  let count = 0
  for (const node of nodes) {
    if (!selected.has(node.id)) continue
    sumX += node.position.x
    sumY += node.position.y
    count += 1
  }
  const center = count > 0 ? { x: sumX / count, y: sumY / count } : { x: 0, y: 0 }

  return {
    selectedIds: [...selected],
    internalEdgeIds,
    inbound,
    outbound,
    center,
  }
}
