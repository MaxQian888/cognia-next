/**
 * Pure planner for "insert node on edge" (C1). Dropping a node onto an existing
 * edge splits it: source → new node → target. This computes the two
 * replacement connections (preserving the upstream `sourceHandle` and the
 * downstream `targetHandle`) and the suggested drop position (the edge
 * midpoint). The store mutator validates each connection before applying.
 */

export interface EdgeEndpoints {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface SplitEdgeSpecs {
  /** source → new node — keeps the original branch/switch/error handle. */
  upstream: { source: string; target: string; sourceHandle?: string }
  /** new node → original target — keeps the original target handle. */
  downstream: { source: string; target: string; targetHandle?: string }
}

export function computeSplitEdges(edge: EdgeEndpoints, newNodeId: string): SplitEdgeSpecs {
  return {
    upstream: {
      source: edge.source,
      target: newNodeId,
      sourceHandle: edge.sourceHandle ?? undefined,
    },
    downstream: {
      source: newNodeId,
      target: edge.target,
      targetHandle: edge.targetHandle ?? undefined,
    },
  }
}

export function edgeMidpoint(
  a: { x: number; y: number },
  b: { x: number; y: number }
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
