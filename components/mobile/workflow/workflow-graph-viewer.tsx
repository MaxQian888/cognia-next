"use client"

/**
 * Mobile workflow graph viewer (Wave 2.9).
 *
 * Read-only vertical layout — node-by-node list with arrows between them
 * — that fits a 360-px-wide phone screen. The desktop canvas-based
 * editor is unfit for thumb-reachable interaction; this viewer keeps
 * the user oriented before they tap "trigger".
 *
 * Topo-sorts nodes by edge graph so the visual order matches execution
 * order. Cycles fall back to source-order to avoid an infinite loop.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ArrowDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface GraphNode {
  id: string
  /** Human-readable label; falls back to id. */
  label?: string
  /** e.g. `"action.character.send"`, `"flow.switch"` — used for the colour tag. */
  kind?: string
  /** Optional summary line. */
  description?: string
}

interface GraphEdge {
  from: string
  to: string
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface WorkflowGraphViewerProps {
  graph: WorkflowGraph
  className?: string
}

export function WorkflowGraphViewer({ graph, className }: WorkflowGraphViewerProps) {
  const t = useTranslations("mobile.workflow")
  const ordered = useMemo(() => topoSort(graph), [graph])

  if (ordered.length === 0) {
    return (
      <div className={cn("rounded-md border border-dashed p-6 text-center", className)}>
        <p className="text-sm text-muted-foreground">{t("graphViewerEmpty")}</p>
      </div>
    )
  }

  return (
    <ol
      className={cn("flex flex-col items-stretch gap-2", className)}
      data-testid="workflow-graph-viewer"
    >
      {ordered.map((node, i) => (
        <li key={node.id} className="flex flex-col items-center">
          <NodeCard node={node} />
          {i < ordered.length - 1 ? (
            <ArrowDownIcon className="my-1 size-4 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function NodeCard({ node }: { node: GraphNode }) {
  return (
    <div
      className="w-full rounded-md border border-border bg-card p-3 shadow-sm"
      data-testid={`workflow-node-${node.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{node.label ?? node.id}</span>
        {node.kind ? (
          <Badge variant="outline" className={cn("text-[10px]", colourFor(node.kind))}>
            {node.kind}
          </Badge>
        ) : null}
      </div>
      {node.description ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{node.description}</p>
      ) : null}
    </div>
  )
}

function colourFor(kind: string): string {
  if (kind.startsWith("trigger.")) return "border-emerald-500/40 text-emerald-700"
  if (kind.startsWith("action.")) return "border-blue-500/40 text-blue-700"
  if (kind.startsWith("ai.")) return "border-violet-500/40 text-violet-700"
  if (kind.startsWith("flow.")) return "border-amber-500/40 text-amber-700"
  if (kind.startsWith("data.")) return "border-rose-500/40 text-rose-700"
  if (kind.startsWith("io.")) return "border-cyan-500/40 text-cyan-700"
  return ""
}

/**
 * Kahn's algorithm with deterministic source-order tiebreak. Returns the
 * source array unchanged when a cycle is detected.
 */
function topoSort(graph: WorkflowGraph): GraphNode[] {
  const { nodes, edges } = graph
  const indegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const byId = new Map<string, GraphNode>()

  for (const node of nodes) {
    indegree.set(node.id, 0)
    adj.set(node.id, [])
    byId.set(node.id, node)
  }
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    adj.get(edge.from)!.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  // Source-order tiebreak: walk nodes in input order to find ones with
  // indegree zero, peel them off in that order.
  const result: GraphNode[] = []
  const remaining = new Set(nodes.map((n) => n.id))
  while (remaining.size > 0) {
    let picked: string | null = null
    for (const n of nodes) {
      if (!remaining.has(n.id)) continue
      if ((indegree.get(n.id) ?? 0) === 0) {
        picked = n.id
        break
      }
    }
    if (picked === null) {
      // Cycle — fall back to source order.
      return nodes
    }
    result.push(byId.get(picked)!)
    remaining.delete(picked)
    for (const next of adj.get(picked) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
    }
  }
  return result
}
