/**
 * Renderer-side "where is the time going" — the browser analogue of the host's
 * span hotspot table.
 *
 * The shared renderer collector keeps a bounded history of every
 * `workflow-ai:*` User Timing measure: chat-turn latency
 * (`chat-turn-performance.ts`), React commit durations (`<PerfBoundary>`,
 * `react:*`) and ad-hoc `measure()` calls. Until now only the opt-in floating
 * HUD read it, so `/performance` on web and mobile — where no host spans
 * exist — had no answer to "what is slow" at all.
 */

import { type7Percentile } from "./comparison"
import { PERF_NAMESPACE } from "./perf-marker"
import type { RendererMeasurementEntry } from "./renderer-collector"

export type RendererTimingCategory = "chat" | "react" | "other"

export interface RendererTimingRow {
  /** Measure name without the `workflow-ai:` namespace. */
  name: string
  category: RendererTimingCategory
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lastMs: number
  /** `performance.now()` start of the newest entry. */
  lastStartTime: number
}

export function rendererTimingCategory(name: string): RendererTimingCategory {
  if (name.startsWith("react:")) return "react"
  if (name.startsWith("chat:")) return "chat"
  return "other"
}

/**
 * One row per measure name, newest-activity first within each category, with
 * chat latency ahead of render commits: chat turns are the user-visible
 * latency, commits explain it.
 */
export function summarizeRendererMeasurements(
  byName: ReadonlyMap<string, readonly RendererMeasurementEntry[]>
): RendererTimingRow[] {
  const rows: RendererTimingRow[] = []
  for (const [rawName, entries] of byName) {
    if (entries.length === 0) continue
    // Long tasks are charted as main-thread blocking on the overview.
    if (rawName === "renderer:long-task") continue
    const name = rawName.startsWith(PERF_NAMESPACE) ? rawName.slice(PERF_NAMESPACE.length) : rawName
    const durations = entries.map((entry) => entry.duration)
    const newest = entries.reduce((latest, entry) =>
      entry.startTime >= latest.startTime ? entry : latest
    )
    rows.push({
      name,
      category: rendererTimingCategory(name),
      count: entries.length,
      p50Ms: type7Percentile(durations, 0.5) ?? 0,
      p95Ms: type7Percentile(durations, 0.95) ?? 0,
      maxMs: Math.max(...durations),
      lastMs: newest.duration,
      lastStartTime: newest.startTime,
    })
  }
  const rank: Record<RendererTimingCategory, number> = { chat: 0, react: 1, other: 2 }
  return rows.sort(
    (left, right) =>
      rank[left.category] - rank[right.category] ||
      right.lastStartTime - left.lastStartTime ||
      left.name.localeCompare(right.name)
  )
}
