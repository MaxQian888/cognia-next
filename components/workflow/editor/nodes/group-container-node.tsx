"use client"

/**
 * Group container node (annotation.group typeVersion 2) — a resizable visual
 * frame that hosts its members as React Flow child nodes (`parentId` + `extent:
 * 'parent'`). Unlike the loop container, a group is NOT an execution boundary:
 * its children are ordinary top-level nodes at run time (see the orchestrator's
 * loop-vs-group distinction). Purely an authoring affordance — no executor.
 *
 * Mirrors `loop-container-node.tsx`'s NodeResizer + handle-less body pattern,
 * minus the loop chrome and source/target handles (a group doesn't wire into
 * the graph itself; its children carry the edges).
 */

import { memo } from "react"
import { NodeResizer, type NodeProps } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { WorkflowNodeRenderData } from "./workflow-node"

const MIN_WIDTH = 200
const MIN_HEIGHT = 120

/** Tailwind class fragments per group color (matches GroupAnnotationConfig). */
const GROUP_COLORS: Record<string, { border: string; bg: string; header: string; ring: string }> = {
  zinc: {
    border: "border-zinc-400/50",
    bg: "bg-zinc-400/5",
    header: "bg-zinc-400/10 border-zinc-400/30",
    ring: "!border-zinc-400",
  },
  emerald: {
    border: "border-emerald-500/50",
    bg: "bg-emerald-500/5",
    header: "bg-emerald-500/10 border-emerald-500/30",
    ring: "!border-emerald-500",
  },
  sky: {
    border: "border-sky-500/50",
    bg: "bg-sky-500/5",
    header: "bg-sky-500/10 border-sky-500/30",
    ring: "!border-sky-500",
  },
  violet: {
    border: "border-violet-500/50",
    bg: "bg-violet-500/5",
    header: "bg-violet-500/10 border-violet-500/30",
    ring: "!border-violet-500",
  },
  amber: {
    border: "border-amber-500/50",
    bg: "bg-amber-500/5",
    header: "bg-amber-500/10 border-amber-500/30",
    ring: "!border-amber-500",
  },
  rose: {
    border: "border-rose-500/50",
    bg: "bg-rose-500/5",
    header: "bg-rose-500/10 border-rose-500/30",
    ring: "!border-rose-500",
  },
  cyan: {
    border: "border-cyan-500/50",
    bg: "bg-cyan-500/5",
    header: "bg-cyan-500/10 border-cyan-500/30",
    ring: "!border-cyan-500",
  },
}

export const GroupContainerNode = memo(function GroupContainerNode(
  props: NodeProps & { data: WorkflowNodeRenderData }
) {
  const { data, selected, id } = props
  const t = useTranslations("workflows.node.groupContainer")
  const params = (data.params ?? {}) as { title?: string; color?: string }
  const color = GROUP_COLORS[params.color ?? "zinc"] ?? GROUP_COLORS.zinc
  const title = params.title || data.label || t("untitled")

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col rounded-lg border-2 border-dashed",
        color.border,
        color.bg,
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.disabled && "opacity-50",
        data.locked && "pointer-events-none"
      )}
      style={{ minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT }}
      data-testid={`wf-group-container-${id}`}
    >
      <NodeResizer
        isVisible={!!selected && !data.locked}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        lineClassName={color.ring}
        handleClassName={cn("!h-2.5 !w-2.5 !rounded-sm", color.ring)}
      />
      <div className={cn("flex items-center gap-2 rounded-t-md border-b px-3 py-2", color.header)}>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-medium text-foreground"
            data-testid="group-container-title"
          >
            {title}
          </div>
        </div>
        {data.locked ? (
          <span className="text-[10px] uppercase opacity-60" data-testid="group-container-locked">
            {t("locked")}
          </span>
        ) : null}
      </div>
      {/* Body — children render on top as real React Flow child nodes; the
          hint only shows through when the group is empty. */}
      <div
        className="flex flex-1 items-center justify-center p-2 text-center text-xs opacity-50"
        data-testid="group-container-dropzone"
      >
        {t("dropHint")}
      </div>
    </div>
  )
})
