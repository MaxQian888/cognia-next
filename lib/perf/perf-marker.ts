/**
 * Workflow-AI rendering performance marks (W3C `performance.mark` / `measure`).
 *
 * Distinct from `lib/plugin/devtools/profiler.ts`, which times plugin
 * operations with `performance.now()` and stores them in an internal map —
 * those entries are invisible to Chrome DevTools' Performance panel. The
 * marks written here emit standard W3C entries that DevTools surfaces inline
 * with the React commits emitted by `<PerfBoundary>`.
 *
 * Safe in SSR / non-browser runtimes: the `performance` global is feature-
 * detected on every call (cheap) so the module can be imported anywhere.
 */

export const PERF_NAMESPACE = "workflow-ai:"

function hasPerfApi(): boolean {
  return (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function"
  )
}

/** Write a `workflow-ai:<name>` mark. No-op when the perf API is missing. */
export function mark(name: string): void {
  if (!hasPerfApi()) return
  try {
    performance.mark(`${PERF_NAMESPACE}${name}`)
  } catch {
    // Some older WebViews throw on duplicate-name marks; safe to ignore.
  }
}

/**
 * Write a `workflow-ai:<name>` measure entry between two prior marks. Returns
 * the entry's duration in ms when available. The side effect (the entry
 * landing on the global perf timeline) is the primary contract — the return
 * value is convenience for ad-hoc callers.
 */
export function measure(name: string, startMark: string, endMark?: string): number | undefined {
  if (!hasPerfApi()) return undefined
  try {
    const entry = performance.measure(
      `${PERF_NAMESPACE}${name}`,
      `${PERF_NAMESPACE}${startMark}`,
      endMark ? `${PERF_NAMESPACE}${endMark}` : undefined
    )
    return entry?.duration
  } catch {
    return undefined
  }
}

/**
 * Write a `workflow-ai:<name>` measure with explicit start + end times. Used
 * by `<PerfBoundary>` so we emit one entry per React commit without having
 * to synthesise intermediate marks.
 */
export function measureRange(name: string, startTime: number, endTime: number): void {
  if (!hasPerfApi()) return
  try {
    performance.measure(`${PERF_NAMESPACE}${name}`, {
      start: startTime,
      end: endTime,
    })
  } catch {
    // Options-object form is unsupported in some legacy engines — skip.
  }
}

/** Clear every `workflow-ai:` mark + measure entry. Used by tests + HUD reset. */
export function clearPerfEntries(): void {
  if (!hasPerfApi()) return
  try {
    const entries = performance.getEntries()
    for (const entry of entries) {
      if (!entry.name.startsWith(PERF_NAMESPACE)) continue
      if (entry.entryType === "mark") performance.clearMarks(entry.name)
      else if (entry.entryType === "measure") performance.clearMeasures(entry.name)
    }
  } catch {
    // ignore
  }
}
