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
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import { useSpanLabels } from "@/hooks/observability/use-span-labels"
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
 * spans for this trace yet".
 *
 * A **nested list**, not an ARIA tree. It used to claim `role="tree"` /
 * `treeitem` with none of the keyboard contract that role promises (no focus,
 * no arrow keys, no expand/collapse) — so a screen reader announced a widget
 * that ignored every key it told the user to press. Nothing here is
 * interactive; a nested `<ul>` conveys the same parent → child structure
 * natively (assistive tech announces list depth), and the active span is
 * marked with `aria-current`.
 *
 * Numbers format in the app locale, the operation id renders as its
 * translated label (raw id in the `title`), and the model column folds by the
 * CONTAINER's width — the tree lives in the log detail pane, whose width has
 * nothing to do with the viewport's `sm:` breakpoint. */
export function AgentTraceTreeView({ spans, activeSpanId, className }: AgentTraceTreeViewProps) {
  const t = useTranslations("logging.panel.agentTrace.tree")
  const tree = useMemo(() => (spans ? buildTree(spans) : []), [spans])
  const totalDurationMs = useMemo(() => (spans ? computeTotalDuration(spans) : 0), [spans])

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
    <div className={cn("@container", className)} data-testid="agent-trace-tree">
      <ul className="flex flex-col gap-0.5" aria-label={t("treeLabel")}>
        {tree.map((node) => (
          <TreeRow
            key={node.span.id}
            node={node}
            activeSpanId={activeSpanId}
            totalDurationMs={totalDurationMs}
          />
        ))}
      </ul>
    </div>
  )
}

interface TreeRowProps {
  node: TreeNode
  activeSpanId?: string
  totalDurationMs: number
}

function TreeRow({ node, activeSpanId, totalDurationMs }: TreeRowProps) {
  const t = useTranslations("logging.panel.agentTrace.tree")
  const fmt = useObservabilityFormatters()
  const labels = useSpanLabels()
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
    <li aria-current={isActive ? "true" : undefined}>
      <div
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
        {isError && <span className="sr-only">{t("failed")}</span>}
        <span className="font-medium shrink-0" title={span.operationName}>
          {labels.operation(span.operationName)}
        </span>
        {inlineParts.length > 0 && (
          <span className="text-muted-foreground truncate">{inlineParts.join(" · ")}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground tabular-nums">
          {model && <span className="hidden @md:inline">{model}</span>}
          {span.usage && (
            <span>
              {t("tokens", {
                input: fmt.compact(span.usage.inputTokens),
                output: fmt.compact(span.usage.outputTokens),
              })}
            </span>
          )}
          {typeof span.costUsdEstimate === "number" && span.costUsdEstimate > 0 && (
            <span>{fmt.usd(span.costUsdEstimate)}</span>
          )}
          <span>{fmt.duration(duration)}</span>
        </span>
      </div>
      <div
        aria-hidden
        className="ml-1 mr-2 mb-0.5 h-0.5 bg-muted-foreground/10"
        style={{ marginLeft: depth * 16 + 14 }}
      >
        <div
          className={cn("h-full", isError ? "bg-destructive/50" : "bg-emerald-500/40")}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      {children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {children.map((child) => (
            <TreeRow
              key={child.span.id}
              node={child}
              activeSpanId={activeSpanId}
              totalDurationMs={totalDurationMs}
            />
          ))}
        </ul>
      )}
    </li>
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
