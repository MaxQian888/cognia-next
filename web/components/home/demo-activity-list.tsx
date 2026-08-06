"use client"

import { useReducedMotion } from "motion/react"

import { AnimatedList } from "@web/components/ui/animated-list"
import { DEMO_TASK, type TestLineState } from "@web/content/demo-task"
import type { TaskArtifactsCopy } from "@web/content/types"

interface DemoActivityListProps {
  copy: TaskArtifactsCopy["test"]
}

/**
 * A bounded test activity feed. The animation reveals the existing demo-task
 * rows once, while the command, line explanations, and summary remain stable.
 */
export function DemoActivityList({ copy }: DemoActivityListProps) {
  const reduced = useReducedMotion() ?? false
  const items = DEMO_TASK.test.lines
  const content = items.map((item) => (
    <ActivityItem
      key={item.key}
      name={item.name}
      state={item.state}
      stateLabel={copy.stateLabels[item.state]}
      note={copy.lineNotes[item.key]}
    />
  ))

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="flex min-w-0 gap-2 font-mono text-xs text-on-stage">
        <span aria-hidden className="text-action">
          $
        </span>
        <span className="break-all">{DEMO_TASK.test.command}</span>
      </p>

      {reduced ? (
        <div role="list" aria-label={copy.heading} className="flex w-full flex-col">
          {content}
        </div>
      ) : (
        <AnimatedList role="list" aria-label={copy.heading} delay={700} className="w-full gap-0">
          {content}
        </AnimatedList>
      )}

      <p className="border-t border-on-stage-hairline pt-4 text-sm leading-relaxed text-on-stage-muted">
        {copy.summary}
      </p>
    </div>
  )
}

function ActivityItem({
  name,
  state,
  stateLabel,
  note,
}: {
  name: string
  state: TestLineState
  stateLabel: string
  note: string
}) {
  const stateIcon = state === "pass" ? "✓" : state === "fail" ? "✗" : "○"
  const stateClass =
    state === "pass"
      ? "text-success"
      : state === "fail"
        ? "text-destructive"
        : "text-on-stage-muted"

  return (
    <div
      role="listitem"
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-t border-on-stage-hairline py-3 first:border-t-0 first:pt-0"
    >
      <span className={stateClass} aria-hidden>
        {stateIcon}
      </span>
      <div className="min-w-0">
        <p className="font-mono text-xs break-words text-on-stage">{name}</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
          {stateLabel}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-on-stage-muted">{note}</p>
      </div>
    </div>
  )
}
