"use client"

import { createElement, memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import {
  Loader2 as LoadingIcon,
  CheckCircle2 as SuccessIcon,
  XCircle as FailedIcon,
  CircleDashed as SkippedIcon,
  AlertTriangle as WarnIcon,
  Timer as TimerIcon,
  Pin as PinIcon,
} from "lucide-react"
import { getNodeIcon } from "@/lib/workflow/editor/node-icons"
import { useFormatter, useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { workflowNodeCategory, type WorkflowNodeKind } from "@/types/workflow/visual"
import type { WorkflowNodeData } from "@/types/workflow/visual"
import type { NodeRunStatus } from "@/lib/workflow/editor/store"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"
import { useEditorStoreOrNull } from "@/lib/workflow/editor/store-context"
import { useNodeDecoration } from "@/lib/workflow/editor/use-node-decoration"
import { getEdgeById, hasEdgeBetween } from "@/lib/workflow/editor/edge-index"
import { outputHandlesFor } from "@/lib/workflow/editor/node-handles"
import { useShallow } from "zustand/react/shallow"
import { flagsForTier, resolveEffectiveTier } from "@/lib/workflow/editor/performance-tier"
import { buildClipboardEnvelope, serializeClipboard } from "@/lib/workflow/editor/clipboard"
import { NodeFloatingToolbar } from "./node-floating-toolbar"

const CATEGORY_COLORS = {
  trigger: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  action: "border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-300",
  ai: "border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300",
  flow: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  data: "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-300",
  io: "border-cyan-500/40 bg-cyan-500/5 text-cyan-700 dark:text-cyan-300",
  annotation: "border-zinc-500/30 bg-zinc-500/5 text-zinc-700 dark:text-zinc-300",
} as const

/** Sticky-note color overrides for `annotation.note` (NoteConfig writes here). */
const STICKY_NOTE_COLORS: Record<string, string> = {
  yellow:
    "border-amber-400/60 bg-amber-100/60 text-amber-900 dark:bg-amber-200/20 dark:text-amber-100",
  green:
    "border-emerald-400/60 bg-emerald-100/60 text-emerald-900 dark:bg-emerald-200/20 dark:text-emerald-100",
  blue: "border-sky-400/60 bg-sky-100/60 text-sky-900 dark:bg-sky-200/20 dark:text-sky-100",
  pink: "border-pink-400/60 bg-pink-100/60 text-pink-900 dark:bg-pink-200/20 dark:text-pink-100",
  violet:
    "border-violet-400/60 bg-violet-100/60 text-violet-900 dark:bg-violet-200/20 dark:text-violet-100",
}

export type WorkflowNodeRenderData = WorkflowNodeData & {
  kind: WorkflowNodeKind
  typeVersion: number
  /** Live execution status, merged in by the canvas from the run-status bridge. */
  runStatus?: NodeRunStatus
  /** Validation summary lines, merged in by the canvas. Used for the tooltip. */
  validationErrors?: string[]
  /** Number of fields with validation errors. Drives the corner badge count. */
  validationErrorCount?: number
  /** Aggregated outcome of the most recent terminal event for this step. */
  lastRun?: LastRunSummary
}

/**
 * Status indicator rendered as a corner badge (-top-1.5 -right-1.5) so it
 * coexists with the selection ring instead of being suppressed by it. The
 * badge sits ABOVE the card border using a solid background colored by status.
 */
const STATUS_BADGE_BG: Record<NodeRunStatus, string> = {
  idle: "",
  running: "bg-amber-500 text-white animate-pulse",
  succeeded: "bg-emerald-500 text-white",
  failed: "bg-rose-500 text-white",
  skipped: "bg-zinc-400 text-white",
  waiting: "bg-sky-500 text-white",
}

function StatusCornerBadge({ status }: { status: NodeRunStatus }) {
  if (status === "idle") return null
  const Icon = (() => {
    switch (status) {
      case "running":
        return LoadingIcon
      case "succeeded":
        return SuccessIcon
      case "failed":
        return FailedIcon
      case "skipped":
        return SkippedIcon
      case "waiting":
        return TimerIcon
    }
  })()
  return (
    <span
      className={cn(
        "absolute -top-1.5 -right-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full shadow ring-2 ring-background",
        STATUS_BADGE_BG[status]
      )}
      aria-label={`Run status: ${status}`}
      data-testid={`wf-node-status-${status}`}
    >
      <Icon className={cn("size-3", status === "running" && "animate-spin")} aria-hidden="true" />
    </span>
  )
}

/**
 * Footer rendered below the node body when there's a previous-run summary
 * AND no live run is in progress. Shows "Ran 12s ago · 1.4s" or
 * "Failed 5m ago" with a hover tooltip carrying the error message.
 */
function LastRunFooter({ lastRun }: { lastRun: LastRunSummary }) {
  const t = useTranslations("workflows.node.lastRun")
  const fmt = useFormatter()
  const ago = (() => {
    try {
      return fmt.relativeTime(new Date(lastRun.finishedAt))
    } catch {
      return new Date(lastRun.finishedAt).toLocaleTimeString()
    }
  })()
  const duration = (() => {
    if (!lastRun.durationMs || lastRun.durationMs <= 0) return ""
    if (lastRun.durationMs < 1000) return `${lastRun.durationMs}ms`
    return `${(lastRun.durationMs / 1000).toFixed(1)}s`
  })()
  const colors =
    lastRun.status === "succeeded"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      : lastRun.status === "failed"
        ? "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
        : "border-zinc-500/30 bg-zinc-500/5 text-zinc-700 dark:text-zinc-300"
  const message =
    lastRun.status === "succeeded"
      ? duration
        ? t("succeeded", { ago, duration })
        : t("succeededNoDuration", { ago })
      : lastRun.status === "failed"
        ? t("failed", { ago })
        : t("skipped", { ago })
  return (
    <div
      title={lastRun.errorMessage ?? undefined}
      className={cn("border-t px-3 py-1 text-[10px] font-medium", colors)}
      data-testid="wf-node-last-run-footer"
      data-status={lastRun.status}
    >
      {message}
      {lastRun.attempt > 1 ? <span className="ml-1 opacity-70">×{lastRun.attempt}</span> : null}
    </div>
  )
}

export const WorkflowNodeComponent = memo(function WorkflowNodeComponent(
  props: NodeProps & { data: WorkflowNodeRenderData }
) {
  const { data, selected, id } = props
  const category = workflowNodeCategory(data.kind)
  // Icon is computed during render but rendered as <icon /> below to avoid
  // the "components created during render" rule — React would otherwise
  // treat each tick's <Icon> as a fresh component type and reset state.
  const icon = getNodeIcon(data.kind)
  const isAnnotation = category === "annotation"
  const showInput = !data.kind.startsWith("trigger.")
  const showOutput = data.kind !== "annotation.note" && data.kind !== "annotation.group"

  // (A4) Per-node decoration — runStatus / validation / lastRun — is read
  // via fine-grained Zustand selectors so unrelated status/validation
  // mutations elsewhere in the graph DO NOT re-render this node. Falls
  // back to the legacy `data.*` fields when a store provider isn't
  // mounted (test renders, storybook).
  const decoration = useNodeDecoration(id)
  const tNode = useTranslations("workflows.node")
  const status: NodeRunStatus = decoration.runStatus ?? data.runStatus ?? "idle"
  const validationFields = decoration.validation?.fields
  const validationSummary = decoration.validation?.summary
  const errorCount = validationFields
    ? Object.keys(validationFields).length
    : (data.validationErrorCount ?? data.validationErrors?.length ?? 0)
  const hasErrors = errorCount > 0
  const errorTooltip = validationSummary ?? data.validationErrors
  const effectiveLastRun = decoration.lastRun ?? data.lastRun

  // Pull whatever store context we can — `null` in headless tests is fine.
  const store = useEditorStoreOrNull()
  // (A3/A5) Narrow selector — drops `nodes` and `edges` arrays from the
  // subscription so node identity changes (the most frequent mutations
  // during editing) no longer re-render every node. Per-render reads of
  // those arrays go through `store.getState()` + the indexed helpers in
  // `edge-index.ts`, which are O(1).
  const storeSelector = useShallow(
    (
      s: Parameters<NonNullable<typeof store>>[0] extends (state: infer S) => unknown ? S : never
    ) => ({
      hoveredNodeId: s.hoveredNodeId,
      setHoveredNode: s.setHoveredNode,
      setSelectedNodes: s.setSelectedNodes,
      removeNodes: s.removeNodes,
      performanceTier: s.performanceTier,
      nodeCount: s.nodes.length,
      spotlightedNodeId: s.spotlightedNodeId,
      hoveredEdgeId: s.hoveredEdgeId,
      connectionState: s.connectionState,
      requestContextMenu: s.requestContextMenu,
      requestRunFromStep: s.requestRunFromStep,
      errorPolicy: s.baseWorkflow.settings.errorPolicy,
    })
  )
  const storeBits = store?.(storeSelector)
  const isHovered = storeBits?.hoveredNodeId === id
  const isSpotlit = storeBits?.spotlightedNodeId === id
  const motionEnabled = storeBits
    ? flagsForTier(
        resolveEffectiveTier(storeBits.performanceTier, {
          nodeCount: storeBits.nodeCount,
          prefersReducedMotion:
            typeof window !== "undefined" && window.matchMedia
              ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
              : false,
        })
      ).nodeCardTransitions
    : true

  // Hovered-edge endpoint ring: when an edge in the workflow is being
  // hovered and one of its endpoints is THIS node, draw a thin primary ring
  // so the user sees which two nodes the edge connects.
  // (A5) Read via the indexed `getEdgeById` helper — O(1) lookup against
  // a WeakMap-cached edge index instead of O(E) `Array.find` per render.
  const isHoveredEdgeEndpoint = (() => {
    if (!storeBits?.hoveredEdgeId || !store) return false
    const edge = getEdgeById(store.getState().edges, storeBits.hoveredEdgeId)
    return !!edge && (edge.source === id || edge.target === id)
  })()

  // Connection-state handle styling (Flowith drag silk). When a connection
  // is in flight from another node, this node's target handle is rendered
  // green (compatible) / red (incompatible) / thick primary (active
  // candidate). The source node itself stays neutral so the user doesn't
  // confuse the source with a candidate.
  const cs = storeBits?.connectionState ?? null
  const isConnectionSource = cs?.sourceId === id
  let connectionRing: "compatible" | "incompatible" | null = null
  let isActiveCandidate = false
  if (cs && !isConnectionSource && showInput && store) {
    isActiveCandidate = cs.candidate?.nodeId === id
    const kindOk = !data.kind.startsWith("trigger.") && data.kind !== "annotation.note"
    // (A5) Disallow self / multi-incoming-cycle creation cheaply via the
    // indexed edge lookup. The canonical gate runs through
    // `validateConnection` when the actual drop happens.
    const wouldCycle = hasEdgeBetween(store.getState().edges, id, cs.sourceId)
    connectionRing = kindOk && !wouldCycle ? "compatible" : "incompatible"
  }

  // Error-branch handle: shown on fallible nodes (not triggers/annotations)
  // when the workflow opts into `errorPolicy: "branch"`.
  const showErrorHandle =
    showOutput &&
    storeBits?.errorPolicy === "branch" &&
    !data.kind.startsWith("trigger.") &&
    !isAnnotation

  // Labeled decision handles (branch/switch v2) — single source of truth in
  // `node-handles.ts`, shared with the connection validator and smart edge.
  const decisionHandles = showOutput
    ? outputHandlesFor({
        kind: data.kind,
        typeVersion: data.typeVersion,
        params: (data.params as Record<string, unknown>) ?? {},
      })
    : null

  // The lastRun footer is suppressed while a run is actively in progress so
  // the user sees current-run state, not stale history.
  const showLastRun = !!effectiveLastRun && status === "idle"
  // Sticky note nodes use the user-picked color instead of the default
  // annotation palette — see `NoteConfig` in inspector/forms/index.tsx.
  const stickyColor =
    data.kind === "annotation.note"
      ? (STICKY_NOTE_COLORS[(data.params as { color?: string } | undefined)?.color ?? "yellow"] ??
        STICKY_NOTE_COLORS.yellow)
      : null

  return (
    <div
      className={cn(
        "group relative min-w-[200px] max-w-[280px] rounded-md border-2 bg-card text-card-foreground shadow-sm transition-shadow",
        // Sticky color (when set) overrides the category palette.
        stickyColor ?? CATEGORY_COLORS[category],
        // Selection ring is the OUTERMOST layer — always visible, even
        // mid-run. Run status now lives in the corner badge below.
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.disabled && "opacity-50",
        isAnnotation && "italic",
        // Spotlight pulse (transient, 3s) — driven by the Spotlight search
        // result jump. Suppressed when reduced-motion is active so the user
        // gets a static thick ring instead of the pulse animation.
        isSpotlit && motionEnabled && "animate-pulse-ring",
        isSpotlit && !motionEnabled && "ring-4 ring-primary",
        // Hovered-edge endpoint ring — see `hoveredEdgeId` in the store.
        // Applied to both source and target nodes so the user sees the
        // pair the hovered edge connects.
        isHoveredEdgeEndpoint &&
          !selected &&
          "ring-2 ring-primary/40 ring-offset-1 ring-offset-background"
      )}
      // Give the card room for every stacked decision handle + label chip.
      style={
        decisionHandles
          ? {
              minHeight: (decisionHandles.length + (showErrorHandle ? 1 : 0)) * 22 + 36,
            }
          : undefined
      }
      data-testid={`wf-node-${data.kind}`}
      data-run-status={status}
      data-spotlit={isSpotlit ? "true" : undefined}
      data-hovered-endpoint={isHoveredEdgeEndpoint ? "true" : undefined}
      data-connection-candidate={isActiveCandidate ? "true" : undefined}
      onMouseEnter={() => storeBits?.setHoveredNode(id)}
      onMouseLeave={() => storeBits?.setHoveredNode(null)}
    >
      <StatusCornerBadge status={status} />
      {data.authoredBy === "ai" ? (
        <span
          className="absolute -top-1.5 -left-1.5 z-10 inline-flex items-center justify-center rounded-full bg-violet-500 px-1.5 text-[9px] font-bold tracking-wide text-white shadow ring-2 ring-background"
          title="Authored by the workflow-AI assistant — Ctrl+Z to revert."
          data-testid="wf-node-ai-badge"
          aria-label="AI-authored node"
        >
          AI
        </span>
      ) : null}
      {storeBits && !isAnnotation ? (
        <NodeFloatingToolbar
          nodeId={id}
          kind={data.kind}
          alwaysVisible={!!selected || isHovered}
          motionEnabled={motionEnabled}
          onRun={() => storeBits.requestRunFromStep(id)}
          onCopy={async () => {
            // (A3) Read node freshly from the store on click instead of
            // subscribing to the entire `nodes` array. Same data, no
            // per-mutation re-render.
            const node = store?.getState().nodes.find((n) => n.id === id)
            if (!node) return
            const env = buildClipboardEnvelope([node], [], [node.id])
            try {
              await navigator.clipboard.writeText(serializeClipboard(env))
            } catch {
              /* best effort */
            }
          }}
          onConfigure={() => storeBits.setSelectedNodes([id])}
          onDelete={() => storeBits.removeNodes([id])}
          onMore={(rect) => {
            // Anchor the canvas context menu at the More button's screen
            // position. The canvas subscribes to `requestedContextMenu` and
            // opens the F1 menu at the given anchor.
            storeBits.requestContextMenu(
              { kind: "node", nodeId: id },
              { x: rect.left + rect.width / 2, y: rect.bottom + 4 }
            )
          }}
        />
      ) : null}
      {showInput ? (
        <Handle
          type="target"
          position={Position.Left}
          className={cn(
            "!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background transition-shadow",
            // Connection-state rings (Flowith "drag silk" preview).
            connectionRing === "compatible" && "ring-2 ring-emerald-500",
            connectionRing === "incompatible" && "ring-2 ring-rose-500/60",
            isActiveCandidate && "!ring-4 !ring-primary",
            connectionRing === "compatible" && motionEnabled && "animate-pulse-handle"
          )}
          data-testid={`wf-node-handle-target-${id}`}
          data-connection-ring={connectionRing ?? undefined}
        />
      ) : null}
      <div className="flex items-start gap-2 px-3 py-2.5">
        {createElement(icon, { className: "size-4 shrink-0 mt-0.5", "aria-hidden": true })}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-medium truncate text-foreground flex-1">{data.label}</div>
            {decoration.pinned ? (
              <span
                title={tNode("pinnedTitle")}
                className="inline-flex items-center rounded-full bg-amber-500/15 px-1 py-px text-amber-600 dark:text-amber-400"
                data-testid="wf-node-pin-badge"
              >
                <PinIcon className="size-3" aria-hidden="true" />
              </span>
            ) : null}
            {hasErrors ? (
              <span
                title={errorTooltip?.join("\n") ?? `${errorCount} validation issue(s)`}
                className="inline-flex items-center gap-0.5 rounded-full bg-destructive/15 px-1.5 py-px text-[10px] font-semibold text-destructive"
                data-testid="wf-node-error-badge"
              >
                <WarnIcon className="size-3" aria-hidden="true" />
                {errorCount}
              </span>
            ) : null}
          </div>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{data.kind}</div>
          {data.notes ? (
            <div className="mt-1.5 text-xs text-muted-foreground line-clamp-2">{data.notes}</div>
          ) : null}
        </div>
      </div>
      {showLastRun && effectiveLastRun ? <LastRunFooter lastRun={effectiveLastRun} /> : null}
      {showOutput ? (
        decisionHandles ? (
          // Labeled multi-output handles (branch/switch v2). Each decision
          // handle is distributed down the right edge with its label chip;
          // the error handle (when the workflow routes errors) sits last.
          <>
            {decisionHandles.map((h, i) => {
              const total = decisionHandles.length + (showErrorHandle ? 1 : 0)
              const top = `${Math.round(((i + 1) / (total + 1)) * 100)}%`
              const label = h.kind === "case" ? (h.label ?? h.id) : tNode(`outputHandles.${h.kind}`)
              return (
                <span key={h.id}>
                  <Handle
                    type="source"
                    id={h.id}
                    position={Position.Right}
                    style={{ top }}
                    className={cn(
                      "!h-3 !w-3 !rounded-full !border-2 !bg-background",
                      h.kind === "true" && "!border-emerald-500",
                      h.kind === "false" && "!border-rose-500",
                      (h.kind === "case" || h.kind === "default") && "!border-current"
                    )}
                    data-testid={`wf-node-handle-out-${id}-${h.id}`}
                  />
                  <span
                    style={{ top }}
                    className="absolute right-2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-wide opacity-70"
                    data-testid={`wf-node-handle-label-${id}-${h.id}`}
                  >
                    {label}
                  </span>
                </span>
              )
            })}
            {showErrorHandle ? (
              <Handle
                type="source"
                id="error"
                position={Position.Right}
                style={{
                  top: `${Math.round(((decisionHandles.length + 1) / (decisionHandles.length + 2)) * 100)}%`,
                }}
                className="!h-3 !w-3 !rounded-full !border-2 !border-rose-500 !bg-background"
                data-testid={`wf-node-handle-error-${id}`}
              />
            ) : null}
          </>
        ) : // When the workflow's errorPolicy is "branch", actions expose a second
        // source handle ("error") that routes the run down a failure path. The
        // success handle shifts up to make room. Triggers/annotations keep a
        // single handle (they can't fail into a branch meaningfully).
        showErrorHandle ? (
          <>
            <Handle
              type="source"
              position={Position.Right}
              style={{ top: "38%" }}
              className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
              data-testid={`wf-node-handle-source-${id}`}
            />
            <Handle
              type="source"
              id="error"
              position={Position.Right}
              style={{ top: "68%" }}
              className="!h-3 !w-3 !rounded-full !border-2 !border-rose-500 !bg-background"
              data-testid={`wf-node-handle-error-${id}`}
            />
          </>
        ) : (
          <Handle
            type="source"
            position={Position.Right}
            className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
          />
        )
      ) : null}
    </div>
  )
})
