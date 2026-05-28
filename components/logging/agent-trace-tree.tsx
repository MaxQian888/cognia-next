"use client"

/**
 * Renders the parent→child span tree for one agent-trace `traceId`. Driven
 * by `useLiveQuery(queryByTrace)` so the tree refreshes the moment new
 * spans (tool calls, sub-agent dispatches) land for the same trace.
 *
 * Mounted by `LogDetailPanel` whenever the user opens a span entry — the
 * full call graph is one click away from the "Agent Trace Detail" section.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { cn } from "@/lib/utils"
import { queryByTrace } from "@/lib/db/agent-traces"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

interface AgentTraceTreeProps {
  traceId: string
  /** Highlight this span (the entry currently focused in the panel). */
  activeSpanId?: string
  className?: string
}

/** Live-query wrapper. Pure rendering split into `AgentTraceTreeView` so
 * unit tests don't need Dexie. */
export function AgentTraceTree({ traceId, activeSpanId, className }: AgentTraceTreeProps) {
  const spans = useLiveQuery(
    () => (traceId ? queryByTrace(traceId) : Promise.resolve([])),
    [traceId],
    undefined as AgentTraceSpan[] | undefined
  )
  return (
    <AgentTraceTreeView spans={spans ?? null} activeSpanId={activeSpanId} className={className} />
  )
}

interface AgentTraceTreeViewProps {
  spans: AgentTraceSpan[] | null
  activeSpanId?: string
  className?: string
}

interface TreeNode {
  span: AgentTraceSpan
  depth: number
  children: TreeNode[]
}

/** Pure rendering surface. Pass `spans === null` for loading; `[]` for "no
 * spans for this trace yet". */
export function AgentTraceTreeView({ spans, activeSpanId, className }: AgentTraceTreeViewProps) {
  const t = useTranslations("logging.panel.agentTrace.tree")
  const tree = useMemo(() => (spans ? buildTree(spans) : []), [spans])

  if (spans === null) {
    return (
      <div
        role="status"
        className={cn("text-xs text-muted-foreground py-2", className)}
        aria-label={t("loading")}
      >
        {t("loading")}
      </div>
    )
  }

  if (spans.length === 0) {
    return <div className={cn("text-xs text-muted-foreground py-2", className)}>{t("empty")}</div>
  }

  return (
    <div
      className={cn("flex flex-col gap-0.5", className)}
      data-testid="agent-trace-tree"
      role="tree"
      aria-label={t("treeLabel")}
    >
      {tree.map((node) => (
        <TreeRow
          key={node.span.id}
          node={node}
          activeSpanId={activeSpanId}
          totalDurationMs={computeTotalDuration(spans)}
          t={t}
        />
      ))}
    </div>
  )
}

interface TreeRowProps {
  node: TreeNode
  activeSpanId?: string
  totalDurationMs: number
  t: ReturnType<typeof useTranslations>
}

function TreeRow({ node, activeSpanId, totalDurationMs, t }: TreeRowProps) {
  const { span, depth, children } = node
  const isActive = activeSpanId === span.id
  const isError = Boolean(span.errorType || span.errorMessage)
  const duration = span.durationMs ?? 0
  const widthPct = totalDurationMs > 0 ? Math.max(2, (duration / totalDurationMs) * 100) : 100
  const inlineParts: string[] = []
  if (span.toolName) inlineParts.push(span.toolName)
  if (span.agentName ?? span.agentId) inlineParts.push(span.agentName ?? span.agentId ?? "")
  const model = span.responseModel ?? span.requestModel
  return (
    <>
      <div
        role="treeitem"
        aria-selected={isActive}
        aria-level={depth + 1}
        data-testid={`agent-trace-tree-row-${span.id}`}
        className={cn(
          "flex items-center gap-2 rounded px-1.5 py-1 text-xs",
          isActive && "bg-muted",
          isError && "text-destructive"
        )}
        style={{ paddingLeft: depth * 16 + 6 }}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            isError ? "bg-destructive" : "bg-emerald-500"
          )}
          aria-hidden
        />
        <span className="font-medium shrink-0">{span.operationName}</span>
        {inlineParts.length > 0 && (
          <span className="text-muted-foreground truncate">{inlineParts.join(" · ")}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground tabular-nums">
          {model && <span className="hidden sm:inline">{model}</span>}
          {span.usage && (
            <span>
              {span.usage.inputTokens}/{span.usage.outputTokens}t
            </span>
          )}
          {typeof span.costUsdEstimate === "number" && span.costUsdEstimate > 0 && (
            <span>{formatUsd(span.costUsdEstimate)}</span>
          )}
          <span>{formatMs(duration)}</span>
        </span>
      </div>
      <div
        className="ml-1 mr-2 mb-0.5 h-0.5 bg-muted-foreground/10"
        style={{ marginLeft: depth * 16 + 14 }}
      >
        <div
          className={cn("h-full", isError ? "bg-destructive/50" : "bg-emerald-500/40")}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      {children.map((child) => (
        <TreeRow
          key={child.span.id}
          node={child}
          activeSpanId={activeSpanId}
          totalDurationMs={totalDurationMs}
          t={t}
        />
      ))}
    </>
  )
}

/** Build a tree of spans by `parentSpanId`. Multiple roots (parents not
 * present in the set) are returned at depth 0; orphan children are also
 * promoted to root so they render instead of being silently dropped. */
function buildTree(spans: AgentTraceSpan[]): TreeNode[] {
  const byId = new Map<string, AgentTraceSpan>()
  for (const s of spans) byId.set(s.spanId, s)
  const childrenByParent = new Map<string, AgentTraceSpan[]>()
  const roots: AgentTraceSpan[] = []
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      const list = childrenByParent.get(s.parentSpanId) ?? []
      list.push(s)
      childrenByParent.set(s.parentSpanId, list)
    } else {
      roots.push(s)
    }
  }
  // Stable chronological order at every level.
  roots.sort((a, b) => a.startTime - b.startTime)
  for (const list of childrenByParent.values()) list.sort((a, b) => a.startTime - b.startTime)
  const visit = (span: AgentTraceSpan, depth: number): TreeNode => ({
    span,
    depth,
    children: (childrenByParent.get(span.spanId) ?? []).map((c) => visit(c, depth + 1)),
  })
  return roots.map((r) => visit(r, 0))
}

function computeTotalDuration(spans: AgentTraceSpan[]): number {
  let total = 0
  for (const s of spans) {
    const d = s.durationMs ?? 0
    if (d > total) total = d
  }
  return total
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}
