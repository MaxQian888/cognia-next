"use client"

import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { DEMO_TASK } from "@web/content/demo-task"
import type { PlanItemState, ReconstructionCopy } from "@web/content/types"
import { useRef } from "react"

import { useScene } from "@web/hooks/use-scene"

interface RunLedgerReconstructionProps {
  copy: ReconstructionCopy
  className?: string
  /**
   * Play the run: each row moves from not started to in progress to done in
   * turn, until the ledger reads as the fixture does. Off, the finished
   * ledger renders at once.
   */
  live?: boolean
}

const STATE_MARK: Record<PlanItemState, { glyph: string; className: string }> = {
  done: { glyph: "✓", className: "text-success" },
  active: { glyph: "◆", className: "text-action" },
  todo: { glyph: "·", className: "text-stone" },
}

/**
 * How long each step holds `in progress` before the next takes over. One phase
 * per plan step, and the final phase is the fixture's own state.
 */
export const LEDGER_PHASE_DELAYS = [700, 700, 700, 700] as const

/**
 * The state row `index` shows at `phase`. The run advances one step per phase:
 * steps before the cursor are done, the step at the cursor is active, the rest
 * have not started. At the final phase every row shows the fixture's state, so
 * the play ends exactly where the static picture is.
 */
export function ledgerState(index: number, phase: number, fixture: PlanItemState): PlanItemState {
  if (phase >= LEDGER_PHASE_DELAYS.length) return fixture
  if (index < phase) return "done"
  if (index === phase) return "active"
  return "todo"
}

/**
 * A run of the workflow, rebuilt as the ledger the runner keeps: one row per
 * node, the tool it used, and the state it reached.
 *
 * The rows are the same four plan steps the graph shows and the same states
 * the hero's ticket shows, because a run *is* that plan executed once. Nothing
 * here is a new figure. Every state carries a glyph and a word, so the ledger
 * survives a monochrome print (spec 8).
 */
export function RunLedgerReconstruction({
  copy,
  className,
  live = false,
}: RunLedgerReconstructionProps) {
  const { workflow, artifacts } = copy
  const headings = workflow.runHeadings
  const ref = useRef<HTMLDivElement>(null)
  const scene = useScene(ref, LEDGER_PHASE_DELAYS)
  const phase = live ? scene.phase : LEDGER_PHASE_DELAYS.length

  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={workflow.runsLabel}
      label={copy.label}
      className={className}
    >
      <div
        ref={ref}
        data-slot="run-ledger"
        data-phase={phase}
        className="flex flex-col gap-4 p-5 md:p-6"
      >
        <PaneHeading>{workflow.runsLabel}</PaneHeading>
        <div className="overflow-hidden rounded-control border border-hairline">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem] gap-px bg-hairline">
            {[headings.step, headings.tool, headings.state].map((heading) => (
              <span
                key={heading}
                className="bg-surface px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted"
              >
                {heading}
              </span>
            ))}
            {DEMO_TASK.plan.map((step, index) => {
              const item = artifacts.plan.items[step.key]
              const state = ledgerState(index, phase, item.state)
              const mark = STATE_MARK[state]
              return [
                <span
                  key={`${step.key}-step`}
                  className="truncate bg-paper px-3 py-2.5 text-xs text-ink"
                >
                  {item.text}
                </span>,
                <span
                  key={`${step.key}-tool`}
                  className="bg-paper px-3 py-2.5 font-mono text-[10px] text-muted"
                >
                  {step.tool}
                </span>,
                <span
                  key={`${step.key}-state`}
                  data-row-state={state}
                  className={`flex items-center gap-1.5 px-3 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted transition-colors duration-300 ${
                    state === "active" ? "bg-surface" : "bg-paper"
                  }`}
                >
                  <span aria-hidden className={mark.className}>
                    {mark.glyph}
                  </span>
                  {artifacts.plan.stateLabels[state]}
                </span>,
              ]
            })}
          </div>
        </div>
      </div>
    </AppFrame>
  )
}
