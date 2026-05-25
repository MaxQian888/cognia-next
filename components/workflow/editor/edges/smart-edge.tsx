"use client"

/**
 * Custom React Flow edge with:
 *   • Heuristic path routing (L-shape when handles align, bezier otherwise).
 *   • Single-blocker midpoint offset so curves bend around intermediate nodes.
 *   • Optional kind chip (`then` / `else` / `true` / `false` / `error`).
 *   • Inline label editing — double-click the midpoint to enter edit mode;
 *     Enter commits, Esc reverts.
 *   • Hover ring on both endpoint nodes (via `hoveredEdgeId` in the store).
 *
 * Animation flags (dashed-draw on `props.animated`) are stripped when the
 * resolved performance tier is `reduced`.
 */

import { memo, useEffect, useMemo, useState } from "react"
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useEditorStoreOrNull } from "@/lib/workflow/editor/store-context"
import { computeSmartRoute, type HandlePosition } from "@/lib/workflow/editor/edge-routing"
import { flagsForTier, resolveEffectiveTier } from "@/lib/workflow/editor/performance-tier"

type EdgeKind = "then" | "else" | "true" | "false" | "error"

const KIND_CLASSES: Record<EdgeKind, string> = {
  then: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  else: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  true: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  false: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  error: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
}

function isEdgeKind(v: unknown): v is EdgeKind {
  return v === "then" || v === "else" || v === "true" || v === "false" || v === "error"
}

function toRouteRect(n: {
  id: string
  position: { x: number; y: number }
  width?: number | null
  height?: number | null
  measured?: { width?: number; height?: number } | null
}) {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: n.measured?.width ?? n.width ?? 240,
    height: n.measured?.height ?? n.height ?? 80,
  }
}

export const SmartEdge = memo(function SmartEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    sourceHandleId,
    markerEnd,
    animated,
    data,
    selected,
  } = props
  const rf = useReactFlow()
  const t = useTranslations("workflows.editor.edge")
  const store = useEditorStoreOrNull()

  // useShallow must be called unconditionally per react-hooks/rules-of-hooks;
  // wrapping the selector in `store?.(...)` made the linter see a conditional
  // call. Extracting fixes it without changing behavior.
  const storeSelector = useShallow(
    (
      s: Parameters<NonNullable<typeof store>>[0] extends (state: infer S) => unknown ? S : never
    ) => ({
      hoveredEdgeId: s.hoveredEdgeId,
      setHoveredEdge: s.setHoveredEdge,
      editingEdgeIdInline: s.editingEdgeIdInline,
      setEditingEdgeIdInline: s.setEditingEdgeIdInline,
      updateEdgeData: s.updateEdgeData,
      performanceTier: s.performanceTier,
      // Subscribe to the node *count* (a primitive), not the `nodes` array —
      // otherwise every drag frame (which replaces the array) re-renders every
      // edge. Mirrors the leaf pattern in `workflow-node.tsx`.
      nodeCount: s.nodes.length,
    })
  )
  const storeBits = store?.(storeSelector)

  const route = useMemo(() => {
    const allNodes = rf.getNodes() as Array<Parameters<typeof toRouteRect>[0]>
    return computeSmartRoute({
      sourceX,
      sourceY,
      sourcePosition: (sourcePosition ?? "right") as HandlePosition,
      targetX,
      targetY,
      targetPosition: (targetPosition ?? "left") as HandlePosition,
      nodes: allNodes.map(toRouteRect),
      excludeNodeIds: [source, target],
    })
  }, [rf, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, source, target])

  const kind = useMemo(() => {
    const v = (data as { kind?: unknown } | undefined)?.kind
    if (isEdgeKind(v)) return v
    // Edges drawn from a node's "error" source handle are error-branch edges
    // even when their data.kind hasn't been stamped.
    if (sourceHandleId === "error") return "error" as EdgeKind
    return null
  }, [data, sourceHandleId])

  const customLabel = useMemo(() => {
    const v = (data as { label?: unknown } | undefined)?.label
    return typeof v === "string" ? v : ""
  }, [data])

  const isHovered = storeBits?.hoveredEdgeId === id
  const isEditing = storeBits?.editingEdgeIdInline === id
  const animations = storeBits
    ? flagsForTier(
        resolveEffectiveTier(storeBits.performanceTier, {
          nodeCount: storeBits.nodeCount,
          prefersReducedMotion:
            typeof window !== "undefined" && window.matchMedia
              ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
              : false,
        })
      ).edgeAnimations
    : true

  const [draft, setDraft] = useState(customLabel)
  useEffect(() => {
    if (isEditing) setDraft(customLabel)
  }, [customLabel, isEditing])

  const commitLabel = () => {
    storeBits?.updateEdgeData(id, { label: draft })
    storeBits?.setEditingEdgeIdInline(null)
  }
  const cancelLabel = () => storeBits?.setEditingEdgeIdInline(null)

  return (
    <>
      <BaseEdge
        path={route.path}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={{
          stroke:
            isHovered || selected
              ? "oklch(var(--primary))"
              : kind === "error"
                ? "#f43f5e"
                : undefined,
          strokeWidth: isHovered || selected ? 2 : 1.5,
          strokeDasharray: animations && animated ? "5 5" : undefined,
        }}
        onMouseEnter={() => storeBits?.setHoveredEdge(id)}
        onMouseLeave={() => {
          if (storeBits?.hoveredEdgeId === id) storeBits.setHoveredEdge(null)
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%,-50%) translate(${route.midpoint.x}px, ${route.midpoint.y}px)`,
            pointerEvents: "all",
          }}
          className="flex items-center gap-1"
          data-testid={`smart-edge-label-${id}`}
        >
          {kind ? (
            <span
              className={cn("rounded-md px-1.5 py-px text-[10px] font-medium", KIND_CLASSES[kind])}
              data-testid={`smart-edge-kind-${id}`}
              data-kind={kind}
            >
              {t(`edgeKind.${kind}`)}
            </span>
          ) : null}
          {isEditing ? (
            <Input
              autoFocus
              className="h-6 w-32 text-xs"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitLabel()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  cancelLabel()
                }
              }}
              placeholder={t("labelPlaceholder")}
              data-testid={`smart-edge-label-input-${id}`}
            />
          ) : customLabel ? (
            <button
              type="button"
              className="rounded-md border bg-background/90 px-1.5 py-px text-xs hover:bg-accent"
              onDoubleClick={() => storeBits?.setEditingEdgeIdInline(id)}
              title={t("editLabelHint")}
              data-testid={`smart-edge-label-button-${id}`}
            >
              {customLabel}
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})
