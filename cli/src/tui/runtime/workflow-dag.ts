/**
 * Pure ASCII renderer for a workflow's graph topology. The TUI has no canvas,
 * so `/workflow inspect`, the copilot proposal preview, and the run replay
 * header all need a text view of "what connects to what". This lays the graph
 * out in dependency layers (a Kahn topological peel) and prints each node with
 * a category glyph + its downstream targets.
 *
 * No Dexie, no Ink, no React — a deterministic string transform over the node
 * and edge arrays, so it's trivially unit-testable and reusable from any
 * surface that already holds a `VisualWorkflow`-shaped graph.
 */
import { workflowNodeCategory, type WorkflowNodeCategory } from "@/types/workflow/visual"

/** Minimal node shape the renderer needs (subset of `WorkflowNode`). */
export interface DagNodeLike {
  id: string
  type: string
  data?: { label?: string }
}

/** Minimal edge shape the renderer needs (subset of `WorkflowEdge`). */
export interface DagEdgeLike {
  source: string
  target: string
}

export interface BuildDagOptions {
  /** Heading printed above the graph (e.g. "Structure"). Omitted ⇒ no heading. */
  title?: string
  /** Max nodes to render before truncating with a "… +N more" note. Default 60. */
  maxNodes?: number
}

const GLYPH: Record<WorkflowNodeCategory, string> = {
  trigger: "◆",
  action: "⚙",
  ai: "✦",
  flow: "◇",
  data: "▤",
  io: "⇄",
  annotation: "▾",
}

/** Category glyph for a node kind — exported so the panel/docs share one map. */
export function nodeGlyph(kind: string): string {
  return GLYPH[workflowNodeCategory(kind as never)] ?? "•"
}

function labelOf(n: DagNodeLike): string {
  const l = n.data?.label?.trim()
  return l && l.length > 0 ? l : n.id
}

/**
 * Layer the graph by dependency depth (Kahn's algorithm). Nodes with no
 * surviving in-edges start at layer 0; each peel removes them and advances
 * their dependents. Any nodes left after the peel are part of a cycle and are
 * grouped into a trailing "cycle" layer so the output never silently drops them.
 */
function layerGraph(
  nodes: DagNodeLike[],
  outgoing: Map<string, string[]>,
  indegree: Map<string, number>
): { layers: string[][]; cyclic: string[] } {
  const remaining = new Map(indegree)
  const placed = new Set<string>()
  const layers: string[][] = []

  // Seed with all indegree-0 nodes, in declaration order for stable output.
  let frontier = nodes.map((n) => n.id).filter((id) => (remaining.get(id) ?? 0) === 0)
  while (frontier.length > 0) {
    layers.push(frontier)
    for (const id of frontier) placed.add(id)
    const next: string[] = []
    for (const id of frontier) {
      for (const t of outgoing.get(id) ?? []) {
        const d = (remaining.get(t) ?? 0) - 1
        remaining.set(t, d)
        if (d === 0 && !placed.has(t)) next.push(t)
      }
    }
    // Preserve declaration order within the next layer.
    frontier = nodes.map((n) => n.id).filter((id) => next.includes(id))
  }

  const cyclic = nodes.map((n) => n.id).filter((id) => !placed.has(id))
  return { layers, cyclic }
}

/**
 * Render the graph as a layered ASCII outline. Returns a single multi-line
 * string (markdown-safe). Empty graphs render a friendly placeholder.
 */
export function buildDagAscii(
  nodes: ReadonlyArray<DagNodeLike>,
  edges: ReadonlyArray<DagEdgeLike>,
  opts: BuildDagOptions = {}
): string {
  const head = opts.title ? `## ${opts.title}\n\n` : ""
  if (nodes.length === 0) return `${head}_(empty workflow — no nodes yet)_`

  const maxNodes = opts.maxNodes ?? 60
  const nodeList = [...nodes]
  const byId = new Map(nodeList.map((n) => [n.id, n]))

  // Keep only edges whose endpoints both exist (drop danglers defensively).
  const liveEdges = edges.filter((e) => byId.has(e.source) && byId.has(e.target))
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const n of nodeList) {
    outgoing.set(n.id, [])
    indegree.set(n.id, 0)
  }
  for (const e of liveEdges) {
    outgoing.get(e.source)!.push(e.target)
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  }

  const { layers, cyclic } = layerGraph(nodeList, outgoing, indegree)

  const lines: string[] = []
  let rendered = 0
  let truncated = 0

  const renderNode = (id: string): void => {
    const n = byId.get(id)
    if (!n) return
    if (rendered >= maxNodes) {
      truncated++
      return
    }
    rendered++
    lines.push(`  ${nodeGlyph(n.type)} ${labelOf(n)}  \`${n.type}\``)
    const targets = outgoing.get(id) ?? []
    for (const t of targets) {
      const tn = byId.get(t)
      if (tn) lines.push(`     → ${labelOf(tn)}`)
    }
  }

  layers.forEach((layer, i) => {
    lines.push(`Layer ${i + 1}:`)
    for (const id of layer) renderNode(id)
  })
  if (cyclic.length > 0) {
    lines.push("Cycle (no entry point):")
    for (const id of cyclic) renderNode(id)
  }
  if (truncated > 0) lines.push(`  … +${truncated} more node(s)`)

  return head + lines.join("\n")
}
