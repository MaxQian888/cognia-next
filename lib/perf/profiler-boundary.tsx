"use client"

/**
 * `<PerfBoundary id>` wraps children in `React.Profiler` outside production
 * builds and writes one `performance.measure` entry per commit through
 * `measureRange()`. In production it returns children directly so the React
 * Profiler tree and the per-commit perf entry write are both elided.
 *
 * Pairs with `<PerfHud>` (which subscribes to the resulting measure entries
 * via PerformanceObserver) and with Chrome DevTools' Performance panel,
 * which surfaces every `workflow-ai:react:<id>` entry inline with the
 * native React DevTools commit timeline.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react"
import { measureRange } from "./perf-marker"

interface Props {
  /** Unique boundary name. Surfaces in the HUD as the `react:<id>` row. */
  id: string
  children: ReactNode
}

const handleRender: ProfilerOnRenderCallback = (
  id,
  _phase,
  actualDuration,
  _baseDuration,
  startTime
) => {
  measureRange(`react:${id}`, startTime, startTime + actualDuration)
}

export function PerfBoundary({ id, children }: Props): ReactNode {
  if (process.env.NODE_ENV === "production") {
    return children
  }
  return (
    <Profiler id={id} onRender={handleRender}>
      {children}
    </Profiler>
  )
}
