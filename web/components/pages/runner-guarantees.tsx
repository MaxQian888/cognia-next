"use client"

import { useRef, type CSSProperties } from "react"

import { Icon } from "@web/components/icon"
import { Section, SectionHeading } from "@web/components/section"
import type { NodeDemoState, RunnerGuaranteesCopy } from "@web/content/types"
import { useScene } from "@web/hooks/use-scene"

interface RunnerGuaranteesProps {
  copy: RunnerGuaranteesCopy
}

/**
 * The nesting bound the runner applies, from
 * `lib/workflow/nodes/shared/executor-support.ts` (`MAX_SUBWORKFLOW_DEPTH`).
 * Pinned to that file by test, so the page cannot keep quoting a limit the
 * runtime has moved.
 */
export const SUBWORKFLOW_DEPTH_LIMIT = 10

/** How long each beat of the four demonstrations holds. */
export const GUARANTEE_STEP_MS = 650

/** Beats per demonstration. Each ends on its finished, static picture. */
const TRIGGER_BEATS = 5
const CYCLE_BEATS = 4
const DEPTH_BEATS = SUBWORKFLOW_DEPTH_LIMIT + 1
const STATES_BEATS = 4

const BEATS = Math.max(TRIGGER_BEATS, CYCLE_BEATS, DEPTH_BEATS, STATES_BEATS)
const DELAYS: readonly number[] = Array.from({ length: BEATS }, () => GUARANTEE_STEP_MS)

const STATE_TONE: Record<NodeDemoState, string> = {
  succeeded: "text-success",
  failed: "text-destructive",
  skipped: "text-muted",
  pending: "text-muted",
}

const STATE_GLYPH: Record<NodeDemoState, string> = {
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
  pending: "·",
}

/**
 * "What the runner guarantees", each guarantee beside a small demonstration
 * of it, on the execution stage.
 *
 * A list of four properties is the page's strongest content and used to be
 * its plainest block. Each row now carries a miniature that shows the property
 * rather than asserting it: five triggers reaching one runner and one record,
 * a back-edge refused on save, a nesting counter stopping at the runtime's
 * limit, and a run whose failed node leaves the rest recorded as skipped.
 *
 * All four run from one clock, once, when the section reaches the viewport,
 * and every one ends on a complete static picture, which is also what reduced
 * motion renders. The pictures are decorative and hidden from assistive
 * technology. The guarantee sentences are the content.
 */
export function RunnerGuarantees({ copy }: RunnerGuaranteesProps) {
  const ref = useRef<HTMLDivElement>(null)
  const scene = useScene(ref, DELAYS, { amount: 0.25 })
  const beat = scene.phase
  const { demos } = copy
  const demo = [
    <TriggersDemo key="triggers" copy={copy} beat={beat} />,
    <CycleDemo key="cycle" copy={copy} beat={beat} />,
    <DepthDemo key="depth" copy={copy} beat={beat} />,
    <StatesDemo key="states" copy={copy} beat={beat} />,
  ]

  return (
    <Section id="guarantees" tone="stage" className="stage-scope">
      <div ref={ref} data-slot="guarantees" data-beat={beat} data-live={scene.live || undefined}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading title={copy.title} tone="stage" />
          <p className="font-mono text-xs uppercase tracking-widest text-muted">{demos.label}</p>
        </div>
        <ol className="mt-10 grid gap-px border-y border-hairline bg-hairline">
          {copy.items.map((item, index) => (
            <li
              key={item}
              data-guarantee={index}
              className="grid gap-6 bg-paper py-7 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16"
            >
              <p className="flex items-start gap-4 text-base leading-relaxed text-muted lg:text-lg">
                <span className="mt-1 shrink-0 font-mono text-xs tabular-nums text-ink">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{item}</span>
              </p>
              <div aria-hidden className="min-w-0">
                {demo[index] ?? null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  )
}

interface DemoProps {
  copy: RunnerGuaranteesCopy
  beat: number
}

const chip =
  "inline-flex items-center rounded-control border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors duration-300"

/** Five triggers, each in turn, reaching one runner and one identical record. */
function TriggersDemo({ copy, beat }: DemoProps) {
  const { demos } = copy
  const current = Math.min(beat, demos.triggers.length - 1)
  return (
    <div data-demo="triggers" className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <ul className="flex flex-wrap gap-1.5 sm:max-w-[11rem]">
        {demos.triggers.map((trigger, index) => (
          <li
            key={trigger}
            data-active={index === current || undefined}
            className={`${chip} ${
              index === current ? "border-action text-ink" : "border-hairline text-muted"
            }`}
          >
            {trigger}
          </li>
        ))}
      </ul>
      <span className="hidden h-px flex-1 bg-hairline-strong sm:block" />
      <div className="flex items-center gap-3 sm:flex-col sm:items-stretch">
        <span className="rounded-control border border-hairline-strong bg-surface px-3 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-ink">
          {demos.runnerLabel}
        </span>
        <span className="flex items-center justify-center gap-2 rounded-control border border-hairline px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted">
          <Icon name="record" size={14} />
          {demos.recordLabel}
        </span>
      </div>
    </div>
  )
}

/** Three nodes, then a back-edge drawn from the last back to the first and refused. */
function CycleDemo({ copy, beat }: DemoProps) {
  const { cycle } = copy.demos
  const attempting = beat >= 2
  const rejected = beat >= 3
  return (
    <div data-demo="cycle" data-rejected={rejected || undefined}>
      <ol className="flex items-center gap-2">
        {cycle.nodes.map((node, index) => (
          <li key={node} className="flex items-center gap-2">
            <span className="rounded-control border border-hairline-strong bg-surface px-3 py-2 text-xs text-ink">
              {node}
            </span>
            {index < cycle.nodes.length - 1 ? (
              <span aria-hidden className="h-px w-5 bg-hairline-strong" />
            ) : null}
          </li>
        ))}
      </ol>
      {/* The back-edge as a U of dashed rules under the row, from the last
       * node back to the first, with the head pointing up into it. */}
      <div
        aria-hidden
        className={`relative mx-7 h-5 w-[calc(100%-3.5rem)] max-w-56 rounded-b-control border-x border-b border-dashed transition-colors duration-300 ${
          attempting ? "opacity-100" : "opacity-0"
        } ${rejected ? "border-destructive" : "border-hairline-strong"}`}
      >
        <span
          className={`absolute -left-[5px] -top-1 size-2 rotate-45 border-l border-t transition-colors duration-300 ${
            rejected ? "border-destructive" : "border-hairline-strong"
          }`}
        />
      </div>
      <p
        className={`mt-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest transition-colors duration-300 ${
          rejected ? "text-destructive" : "text-muted"
        }`}
      >
        {rejected ? <Icon name="close" size={14} /> : null}
        {rejected ? cycle.rejectedLabel : cycle.attemptLabel}
      </p>
    </div>
  )
}

/** Nesting depth counting up to the runtime's limit and stopping there. */
function DepthDemo({ copy, beat }: DemoProps) {
  const { depth } = copy.demos
  const level = Math.min(beat, SUBWORKFLOW_DEPTH_LIMIT)
  const atLimit = level >= SUBWORKFLOW_DEPTH_LIMIT
  const shown = Math.min(level, 4)
  return (
    <div data-demo="depth" data-level={level} className="flex items-center gap-5">
      <div className="relative h-16 w-24 shrink-0">
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className={`absolute inset-0 rounded-control border transition-opacity duration-300 ${
              index === 0 ? "border-hairline-strong" : "border-hairline"
            } ${index <= shown ? "opacity-100" : "opacity-0"} ${
              index === 4 && atLimit ? "border-dashed border-destructive" : ""
            }`}
            style={{ inset: `${index * 6}px` } as CSSProperties}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-widest">
        <span className="text-muted">{depth.label}</span>
        <span className="text-2xl normal-case tabular-nums tracking-tight text-ink">
          {level} <span className="text-sm text-muted">{depth.workflowLabel}</span>
        </span>
        <span className={`flex items-center gap-2 ${atLimit ? "text-destructive" : "text-muted"}`}>
          {atLimit ? <Icon name="close" size={14} /> : null}
          {depth.limitLabel} {SUBWORKFLOW_DEPTH_LIMIT}
        </span>
      </div>
    </div>
  )
}

/** A run in which one node fails and the remaining nodes are recorded as skipped. */
function StatesDemo({ copy, beat }: DemoProps) {
  const { states } = copy.demos
  return (
    <ul data-demo="states" className="flex flex-col gap-px border border-hairline bg-hairline">
      {states.items.map((item, index) => {
        const revealed = beat > index
        const state: NodeDemoState = revealed ? item.state : "pending"
        return (
          <li
            key={item.name}
            data-state={state}
            className="flex items-center gap-3 bg-paper px-3 py-2 text-xs"
          >
            <span aria-hidden className={`w-3 text-center ${STATE_TONE[state]}`}>
              {STATE_GLYPH[state]}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink">{item.name}</span>
            <span
              className={`font-mono text-[10px] uppercase tracking-widest transition-colors duration-300 ${STATE_TONE[state]}`}
            >
              {states.stateLabels[state]}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
