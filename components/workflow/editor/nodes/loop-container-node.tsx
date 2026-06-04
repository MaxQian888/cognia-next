"use client"

/**
 * Loop container node (flow.loop typeVersion 2) — a resizable sub-canvas that
 * hosts its body nodes as React Flow child nodes (`parentId` + `extent:
 * 'parent'`). The header shows the loop mode + source; the translucent body
 * area is the drop zone the canvas re-parents nodes into.
 *
 * Rendering only — execution lives in `lib/workflow/runtime/loop-container.ts`,
 * re-parenting in the canvas/store layer.
 */

import { memo } from "react"
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react"
import { Repeat as LoopIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { WorkflowNodeRenderData } from "./workflow-node"

const MIN_WIDTH = 320
const MIN_HEIGHT = 200

export const LoopContainerNode = memo(function LoopContainerNode(
  props: NodeProps & { data: WorkflowNodeRenderData }
) {
  const { data, selected, id } = props
  const t = useTranslations("workflows.node.loopContainer")
  const params = (data.params ?? {}) as {
    mode?: string
    source?: string
    times?: number | string
    whileExpression?: string
    iterationConcurrency?: number
  }
  const mode = params.mode ?? "forEach"
  const modeDetail =
    mode === "times"
      ? String(params.times ?? "")
      : mode === "while"
        ? (params.whileExpression ?? "")
        : (params.source ?? "")

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col rounded-lg border-2 border-dashed border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.disabled && "opacity-50"
      )}
      style={{ minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT }}
      data-testid={`wf-loop-container-${id}`}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        lineClassName="!border-amber-500"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !bg-amber-500"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
        data-testid={`loop-container-target-${id}`}
      />
      <div className="flex items-center gap-2 rounded-t-md border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <LoopIcon className="size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{data.label}</div>
          <div
            className="truncate font-mono text-[10px] opacity-70"
            data-testid="loop-container-mode"
          >
            {t(
              `mode.${mode === "forEach" || mode === "times" || mode === "while" ? mode : "forEach"}`
            )}
            {modeDetail ? ` · ${modeDetail}` : ""}
          </div>
        </div>
      </div>
      {/* Body drop zone — children render on top of this area as real React
          Flow child nodes; the hint only shows through when empty. */}
      <div
        className="flex flex-1 items-center justify-center p-2 text-center text-xs opacity-50"
        data-testid="loop-container-dropzone"
      >
        {t("dropHint")}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !rounded-full !border-2 !border-current !bg-background"
        data-testid={`loop-container-source-${id}`}
      />
    </div>
  )
})
