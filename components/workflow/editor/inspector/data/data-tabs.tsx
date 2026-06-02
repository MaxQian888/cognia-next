"use client"

/**
 * The `Config | Input | Output` segmented control hosted at the top of the
 * inspector. Config renders the existing per-kind form (passed as children);
 * Input/Output render the NDV data panels resolved from the latest run + pins.
 */

import { type ReactNode, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLatestRunOutputs } from "@/hooks/workflow/use-latest-run-outputs"
import { resolveNodeIo } from "@/lib/workflow/editor/node-io-data"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { DataPanel } from "./data-panel"

type Tab = "config" | "input" | "output"

export function DataTabs({
  useStore,
  nodeId,
  children,
}: {
  useStore: EditorStore
  nodeId: string
  children: ReactNode
}) {
  const t = useTranslations("workflows.dataView")
  const [tab, setTab] = useState<Tab>("config")

  const { nodes, edges, workflowId, pinData, isDraggingAny } = useStore(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      workflowId: s.baseWorkflow.id,
      pinData: s.baseWorkflow.pinData,
      isDraggingAny: s.isDraggingAny,
    }))
  )
  const { pinNodeData, unpinNodeData, requestRunSingleStep } = useStore(
    useShallow((s: EditorState) => ({
      pinNodeData: s.pinNodeData,
      unpinNodeData: s.unpinNodeData,
      requestRunSingleStep: s.requestRunSingleStep,
    }))
  )

  const latestOutputs = useLatestRunOutputs(workflowId, !isDraggingAny, { anyStatus: true })

  const io = useMemo(
    () =>
      resolveNodeIo({
        nodeId,
        nodes: nodes as unknown as Parameters<typeof resolveNodeIo>[0]["nodes"],
        edges: edges as unknown as Parameters<typeof resolveNodeIo>[0]["edges"],
        latestOutputs,
        pinData,
      }),
    [nodeId, nodes, edges, latestOutputs, pinData]
  )

  return (
    <div className="space-y-3">
      <ToggleGroup
        type="single"
        size="sm"
        value={tab}
        onValueChange={(v) => v && setTab(v as Tab)}
        aria-label={t("tabsAria")}
        className="w-full"
      >
        <ToggleGroupItem value="config" className="flex-1 h-7 text-[11px]">
          {t("tabConfig")}
        </ToggleGroupItem>
        <ToggleGroupItem value="input" className="flex-1 h-7 text-[11px]">
          {t("tabInput")}
        </ToggleGroupItem>
        <ToggleGroupItem value="output" className="flex-1 h-7 text-[11px]">
          {t("tabOutput")}
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === "config" ? children : null}

      {tab === "output" ? (
        <DataPanel
          sourceNodeId={nodeId}
          value={io.output.value}
          source={io.output.source}
          pin={{
            pinned: io.output.pinned,
            onPin: (value) => pinNodeData(nodeId, value),
            onUnpin: () => unpinNodeData(nodeId),
          }}
          onRunStep={() => requestRunSingleStep(nodeId)}
        />
      ) : null}

      {tab === "input" ? (
        io.inputs.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground" data-testid="no-inputs">
            {t("noInputs")}
          </p>
        ) : (
          <div className="space-y-4">
            {io.inputs.map((entry) => (
              <section key={entry.upstreamNodeId} className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("inputFrom", { label: entry.upstreamLabel })}
                </p>
                <DataPanel
                  sourceNodeId={entry.upstreamNodeId}
                  value={entry.value}
                  source={entry.source}
                />
              </section>
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}
