"use client"

import { useMemo } from "react"
import { Background, Controls, MarkerType, Position, ReactFlow } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useTranslations } from "next-intl"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"
import { workflowToReactFlow } from "@/lib/workflow/editor/react-flow-converter"
import { buildSpans, formatDurationMs } from "./format"

const COLORS = {
  pending: "#64748b",
  running: "#2563eb",
  succeeded: "#16a34a",
  failed: "#dc2626",
  skipped: "#94a3b8",
}

/** Read-only run canvas. Reuse authored positions and the timeline's retry semantics. */
export function RunGraph({
  workflow,
  events,
  startedAt,
  completedAt,
  selectedStepId,
  onSelectStep,
}: {
  workflow: VisualWorkflow
  events: WorkflowRunEventRow[]
  startedAt: number
  completedAt?: number
  selectedStepId: string | null
  onSelectStep: (id: string) => void
}) {
  const t = useTranslations("workflows.runs.graph")
  const { nodes, edges } = useMemo(() => {
    const end = completedAt ?? events.reduce((max, event) => Math.max(max, event.ts), startedAt)
    const spans = new Map(buildSpans(events, end).map((span) => [span.stepId, span]))
    const converted = workflowToReactFlow(workflow)
    return {
      nodes: converted.nodes.map((node) => {
        const span = spans.get(node.id)
        const status = span?.status ?? "pending"
        return {
          id: node.id,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          position: node.position,
          parentId: node.parentId,
          ...(node.type !== "workflowNode" ? { width: node.width, height: node.height } : {}),
          data: {
            label: (
              <div className="space-y-1">
                <div className="font-medium">{node.data.label}</div>
                <div className="text-xs">
                  {t(status)}
                  {span ? ` · ${formatDurationMs(span.endTs - span.startTs)}` : ""}
                </div>
              </div>
            ),
          },
          selected: selectedStepId === node.id,
          style: {
            border: `2px solid ${COLORS[status]}`,
            borderRadius: 12,
            background: "var(--card)",
            color: "var(--card-foreground)",
            boxShadow: selectedStepId === node.id ? `0 0 0 3px ${COLORS[status]}44` : undefined,
          },
          ariaLabel: `${node.data.label} · ${t(status)}`,
        }
      }),
      edges: converted.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        markerEnd: { type: MarkerType.ArrowClosed },
        // A running target does not prove which conditional edge was taken.
        style: { stroke: "#94a3b8", strokeWidth: 1.5 },
      })),
    }
  }, [workflow, events, startedAt, completedAt, selectedStepId, t])
  return (
    <section aria-label={t("title")} className="mb-6 overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      <div className="h-[420px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          onNodeClick={(_, node) => onSelectStep(node.id)}
          minZoom={0.1}
          maxZoom={2}
          ariaLabelConfig={{
            "controls.zoomIn.ariaLabel": t("zoomIn"),
            "controls.zoomOut.ariaLabel": t("zoomOut"),
            "controls.fitView.ariaLabel": t("fit"),
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  )
}
