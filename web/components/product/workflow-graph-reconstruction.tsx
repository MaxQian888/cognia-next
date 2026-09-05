"use client"

import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { Icon, type IconName } from "@web/components/icon"
import { DEMO_TASK } from "@web/content/demo-task"
import type { PlanItemState, ReconstructionCopy } from "@web/content/types"
import { useRef } from "react"

import { useScene } from "@web/hooks/use-scene"

interface WorkflowGraphReconstructionProps {
  copy: ReconstructionCopy
  className?: string
  /**
   * Build the graph in front of the reader: the trigger, then one node per
   * plan step, then a back-edge that validation refuses. Off, the finished
   * graph renders at once.
   */
  live?: boolean
}

/** One mark per tool the plan names. */
const TOOL_ICON: Record<string, IconName> = {
  terminal: "terminal",
  editor: "files",
  artifact: "artifact",
}

const STATE_RING: Record<PlanItemState, string> = {
  done: "border-success",
  active: "border-action",
  todo: "border-hairline-strong",
}

/**
 * How long each node holds before the next lands, then the pause before the
 * back-edge is drawn and refused. The last phase is the rejection.
 */
export const GRAPH_PHASE_DELAYS = [500, 500, 500, 500, 900] as const

/** The phase at which the graph is complete and the back-edge appears. */
export const GRAPH_REJECT_PHASE = GRAPH_PHASE_DELAYS.length

/**
 * The workflow editor, rebuilt (ADR-0092 8, amended): the signature task's
 * four plan steps as nodes on a graph, with a trigger in front of them.
 *
 * The nodes are the plan. That is the page's claim in miniature, that a
 * workflow is the repeatable version of work already done once, and it costs
 * no new fixture: titles come from the plan copy, tools from `DEMO_TASK`.
 * Edges are drawn as rules between the cells rather than as an SVG canvas, so
 * the graph reflows with the column it lands in and stays legible at a phone
 * width, where it becomes a vertical chain.
 *
 * Live, the graph builds itself node by node and then a dashed back-edge from
 * the last node to the second is drawn and tagged as rejected. Validation
 * refuses every cycle when the graph is saved (`collectUnauthorizedCycleNodes`),
 * and showing the refusal is worth more than stating it. The refused edge stays
 * in the finished picture, so the reduced-motion reader sees the same claim.
 */
export function WorkflowGraphReconstruction({
  copy,
  className,
  live = false,
}: WorkflowGraphReconstructionProps) {
  const { workflow, artifacts } = copy
  const ref = useRef<HTMLDivElement>(null)
  const scene = useScene(ref, GRAPH_PHASE_DELAYS)
  const phase = live ? scene.phase : GRAPH_REJECT_PHASE
  const rejecting = phase >= GRAPH_REJECT_PHASE

  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={workflow.graphLabel}
      label={copy.label}
      className={className}
    >
      <div
        ref={ref}
        data-slot="workflow-graph"
        data-phase={phase}
        className="relative flex flex-col gap-4 p-5 md:p-6"
      >
        <PaneHeading>{workflow.graphLabel}</PaneHeading>
        <ol className="relative flex flex-col">
          <li className="flex items-stretch gap-3">
            <span className="flex w-5 shrink-0 flex-col items-center">
              <span aria-hidden className="size-2 rounded-full bg-action" />
              <span aria-hidden className="w-px flex-1 bg-hairline-strong" />
            </span>
            <div className="mb-3 flex min-w-0 flex-1 items-center gap-3 rounded-control border border-dashed border-hairline-strong bg-paper px-3 py-2">
              <Icon name="bell" size={14} className="shrink-0 text-muted" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {workflow.triggerLabel}
              </span>
              <span className="ml-auto truncate text-xs text-ink">{workflow.triggerName}</span>
            </div>
          </li>
          {DEMO_TASK.plan.map((step, index) => {
            const item = artifacts.plan.items[step.key]
            const last = index === DEMO_TASK.plan.length - 1
            const landed = phase > index
            return (
              <li
                key={step.key}
                data-node={step.key}
                data-landed={landed || undefined}
                className={`flex items-stretch gap-3 transition-opacity duration-300 ${
                  landed ? "opacity-100" : "opacity-0"
                } ${landed && scene.live ? "animate-[fade-through_320ms_ease-out_both]" : ""}`}
              >
                <span className="flex w-5 shrink-0 flex-col items-center">
                  <span
                    aria-hidden
                    className={`size-2 rounded-full border-2 ${STATE_RING[item.state]}`}
                  />
                  {last ? null : <span aria-hidden className="w-px flex-1 bg-hairline-strong" />}
                </span>
                <div
                  className={`${last ? "" : "mb-3"} flex min-w-0 flex-1 items-start gap-3 rounded-control border bg-surface px-3 py-2.5 ${
                    item.state === "active" ? "border-action" : "border-hairline"
                  }`}
                >
                  <Icon
                    name={TOOL_ICON[step.tool] ?? "action"}
                    size={14}
                    className="mt-0.5 shrink-0 text-muted"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-ink">{item.text}</span>
                    <span className="mt-1 block font-mono text-[10px] uppercase tracking-widest text-muted">
                      {step.tool}
                    </span>
                  </span>
                </div>
              </li>
            )
          })}

          {/* The back-edge: from the last node up to the second, along the
           * right margin, refused. A picture of a rejected edit, so hidden
           * from assistive technology. The tag below carries the words. */}
          <svg
            aria-hidden
            data-slot="back-edge"
            data-rejected={rejecting || undefined}
            className={`pointer-events-none absolute -right-1 top-[4.25rem] h-[calc(100%-4.25rem)] w-6 text-destructive transition-opacity duration-300 ${
              rejecting ? "opacity-100" : "opacity-0"
            }`}
            viewBox="0 0 24 100"
            preserveAspectRatio="none"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
          >
            <path d="M4 96 H16 V6 H6" />
            <path d="M10 2 L6 6 L10 10" strokeDasharray="0" />
          </svg>
        </ol>
        <p
          data-slot="cycle-tag"
          className={`flex items-center gap-2 self-end font-mono text-[10px] uppercase tracking-widest text-destructive transition-opacity duration-300 ${
            rejecting ? "opacity-100" : "opacity-0"
          }`}
        >
          <Icon name="close" size={14} />
          {workflow.cycleRejectedLabel}
        </p>
      </div>
    </AppFrame>
  )
}
