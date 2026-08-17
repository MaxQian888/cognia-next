"use client"

// Which installed Pi packages are competing for the same job.
//
// Pi has no package sandbox and no dependency resolver: nothing stops two
// footers, two MCP adapters or two permission layers from being installed
// together, and Pi will never warn about it. When it happens they fight over
// the same hooks and tool names, duplicate prompts, and grow the schema surface
// without adding independent capability. This graph is the only place a user
// finds out.
//
// Layout is computed, not stored: one hub node per contested capability group
// with its packages fanned around it. Everything is deterministic — same input,
// same positions — so the graph does not reshuffle between renders. It is
// non-interactive on purpose (no dragging, no connecting): the arrangement
// carries the meaning, so letting a user scramble it would only destroy
// information.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { NetworkIcon } from "lucide-react"
import { Background, BackgroundVariant, ReactFlow, type Edge, type Node } from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { Card } from "@/components/ui/card"
import type { PiOverlapConflict } from "@/lib/pi-packages/conflicts"
import { piPackageShortName } from "./pi-context-budget"

const PRO_OPTIONS = { hideAttribution: true } as const

/** Geometry. Deliberately plain constants — the layout is a fan, not a solver. */
const CLUSTER_SPACING_Y = 190
const HUB_X = 40
const LEAF_X = 260
const LEAF_SPACING_Y = 56

export interface PiOverlapGraphModel {
  nodes: Node[]
  edges: Edge[]
  height: number
}

/**
 * Build the graph. Pure and exported so the layout can be asserted without
 * mounting React Flow, which does not render meaningfully in jsdom.
 */
export function buildPiOverlapGraph(
  conflicts: readonly PiOverlapConflict[],
  labels: { group: (group: string) => string }
): PiOverlapGraphModel {
  const nodes: Node[] = []
  const edges: Edge[] = []

  conflicts.forEach((conflict, clusterIndex) => {
    const hubId = `group:${conflict.group}`
    // Centre the fan on the hub so an even and an odd count both look balanced.
    const clusterTop = clusterIndex * CLUSTER_SPACING_Y
    const fanHeight = (conflict.entries.length - 1) * LEAF_SPACING_Y

    nodes.push({
      id: hubId,
      position: { x: HUB_X, y: clusterTop + fanHeight / 2 },
      data: { label: labels.group(conflict.group) },
      type: "default",
      draggable: false,
      connectable: false,
      selectable: false,
      className: "!border-destructive/60 !bg-destructive/10 !text-xs !font-medium",
    })

    conflict.entries.forEach((entry, leafIndex) => {
      const leafId = `${hubId}:${entry.id}`
      nodes.push({
        id: leafId,
        position: { x: LEAF_X, y: clusterTop + leafIndex * LEAF_SPACING_Y },
        data: { label: piPackageShortName(entry.spec) },
        type: "default",
        draggable: false,
        connectable: false,
        selectable: false,
        className:
          entry.tier === "avoid"
            ? "!border-destructive !text-xs !font-mono"
            : "!text-xs !font-mono",
      })
      edges.push({
        id: `e:${leafId}`,
        source: hubId,
        target: leafId,
        animated: false,
        selectable: false,
        className: "!stroke-destructive/50",
      })
    })
  })

  const lastFan = conflicts.length
    ? (conflicts[conflicts.length - 1].entries.length - 1) * LEAF_SPACING_Y
    : 0
  return {
    nodes,
    edges,
    height: conflicts.length ? (conflicts.length - 1) * CLUSTER_SPACING_Y + lastFan + 120 : 0,
  }
}

interface Props {
  conflicts: readonly PiOverlapConflict[]
}

export function PiOverlapGraph({ conflicts }: Props) {
  const t = useTranslations("plugins.agentPackages.overlaps")

  const model = useMemo(
    () => buildPiOverlapGraph(conflicts, { group: (group) => t(`group.${group}`) }),
    [conflicts, t]
  )

  return (
    <Card className="space-y-3 p-4" data-testid="pi-overlap-graph">
      <div className="flex items-start gap-2">
        <NetworkIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
        </div>
      </div>

      {conflicts.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="pi-overlap-empty">
          {t("none")}
        </p>
      ) : (
        <>
          <ul className="space-y-0.5 text-xs">
            {conflicts.map((conflict) => (
              <li key={conflict.group} className="text-destructive">
                {t("conflict", {
                  count: conflict.entries.length,
                  group: t(`group.${conflict.group}`),
                })}
              </li>
            ))}
          </ul>
          <div
            className="overflow-hidden rounded-md border"
            style={{ height: Math.min(model.height, 420) }}
            aria-label={t("graphLabel")}
          >
            <ReactFlow
              nodes={model.nodes}
              edges={model.edges}
              proOptions={PRO_OPTIONS}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag
              zoomOnScroll={false}
              zoomOnDoubleClick={false}
              minZoom={0.4}
              maxZoom={1.2}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            </ReactFlow>
          </div>
        </>
      )}
    </Card>
  )
}
