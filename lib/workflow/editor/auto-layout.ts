/**
 * elkjs-based auto-layout. Takes the current React Flow nodes/edges and
 * returns updated `position` values for each node using ELK's `layered`
 * algorithm — the same one React Flow's official Workflow Editor template uses.
 *
 * elkjs is loaded lazily (dynamic import) so the editor's first paint isn't
 * blocked by the ~250 KB bundle. The function falls back to leaving
 * positions untouched if elkjs isn't available (web fallback only — Tauri
 * always has it).
 */

import type { RFWorkflowEdge, RFWorkflowNode } from "./react-flow-converter"

interface ElkNodeShape {
  id: string
  width?: number
  height?: number
  children?: ElkNodeShape[]
  edges?: ElkEdgeShape[]
  layoutOptions?: Record<string, string>
  x?: number
  y?: number
}

interface ElkEdgeShape {
  id: string
  sources: string[]
  targets: string[]
}

interface ElkInstance {
  layout(graph: ElkNodeShape): Promise<ElkNodeShape>
}

const DEFAULT_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.nodeNode": "60",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.layered.crossingMinimization.semiInteractive": "true",
}

const DEFAULT_NODE_WIDTH = 220
const DEFAULT_NODE_HEIGHT = 80

/** Editor-facing flow directions mapped onto elkjs' `elk.direction` values. */
export const ELK_DIRECTIONS = {
  LR: "RIGHT",
  RL: "LEFT",
  TB: "DOWN",
  BT: "UP",
} as const

export type AutoLayoutDirection = keyof typeof ELK_DIRECTIONS

export interface AutoLayoutOptions {
  /** Flow direction. Omit for the project default (LR / `RIGHT`). */
  direction?: AutoLayoutDirection
}

let cachedElk: ElkInstance | null = null

async function loadElk(): Promise<ElkInstance | null> {
  if (cachedElk) return cachedElk
  try {
    const mod = await import("elkjs/lib/elk.bundled.js")
    type ElkCtor = new () => ElkInstance
    const ElkCtor = ((mod as unknown as { default?: ElkCtor }).default ??
      (mod as unknown as ElkCtor)) as ElkCtor
    cachedElk = new ElkCtor()
    return cachedElk
  } catch {
    return null
  }
}

/**
 * Run elkjs over the given graph and return new positions for each node.
 * Edges are not modified — React Flow re-routes them automatically once the
 * source/target positions update.
 */
export async function autoLayout(
  nodes: RFWorkflowNode[],
  edges: RFWorkflowEdge[],
  options: AutoLayoutOptions = {}
): Promise<Record<string, { x: number; y: number }>> {
  const elk = await loadElk()
  if (!elk || nodes.length === 0) return {}

  const graph: ElkNodeShape = {
    id: "root",
    layoutOptions: options.direction
      ? { ...DEFAULT_LAYOUT_OPTIONS, "elk.direction": ELK_DIRECTIONS[options.direction] }
      : DEFAULT_LAYOUT_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      width: typeof n.width === "number" ? n.width : DEFAULT_NODE_WIDTH,
      height: typeof n.height === "number" ? n.height : DEFAULT_NODE_HEIGHT,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const laid = await elk.layout(graph)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const child of laid.children ?? []) {
    if (typeof child.x === "number" && typeof child.y === "number") {
      positions[child.id] = { x: child.x, y: child.y }
    }
  }
  return positions
}

/** Apply a position map returned by `autoLayout` to a node array. */
export function applyAutoLayoutPositions(
  nodes: RFWorkflowNode[],
  positions: Record<string, { x: number; y: number }>
): RFWorkflowNode[] {
  return nodes.map((n) => {
    const next = positions[n.id]
    return next ? { ...n, position: { x: next.x, y: next.y } } : n
  })
}
