/**
 * Background subagent run registry (A5).
 *
 * When `dispatch_agent` is called with `background: true`, the dispatch starts
 * but the tool returns `{ runId, backgrounded: true }` immediately instead of
 * blocking. The in-flight promise is parked here keyed by `runId`; the model
 * collects the result later via `dispatch_agent({ collect: runId })`, which
 * calls {@link collectBackgroundResult}.
 *
 * Pure module — the promise lifecycle is self-contained. Mirrors the team
 * inflight-guard pattern.
 */

import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

interface Entry {
  promise: Promise<PluginSubagentDispatchResult>
  settled?: PluginSubagentDispatchResult
  error?: string
}

const runs = new Map<string, Entry>()

/**
 * Park a background run. The promise is tracked so a later `collect` can await
 * (or read) its outcome. Resolution/rejection is recorded so collection after
 * settlement is synchronous.
 */
export function startBackgroundRun(
  runId: string,
  promise: Promise<PluginSubagentDispatchResult>
): void {
  const entry: Entry = { promise }
  runs.set(runId, entry)
  promise.then(
    (r) => {
      entry.settled = r
    },
    (err) => {
      entry.error = err instanceof Error ? err.message : String(err)
    }
  )
}

/** Whether a background run id is known (in-flight or settled). */
export function hasBackgroundRun(runId: string): boolean {
  return runs.has(runId)
}

/**
 * Await (or read) a background run's result. Returns `undefined` for an unknown
 * id. A rejected run resolves to a result-shaped error envelope so the caller
 * always has a tool-result string. The entry is dropped once collected.
 */
export async function collectBackgroundResult(
  runId: string
): Promise<PluginSubagentDispatchResult | undefined> {
  const entry = runs.get(runId)
  if (!entry) return undefined
  try {
    const result = await entry.promise
    runs.delete(runId)
    return result
  } catch (err) {
    runs.delete(runId)
    return {
      text: err instanceof Error ? err.message : String(err),
      channel: "text",
      toolsAvailable: false,
      runId,
      finishReason: "error",
    }
  }
}

/** List the currently-known background run ids. */
export function listBackgroundRuns(): string[] {
  return [...runs.keys()]
}

/** Test-only: drop all parked runs. */
export function __clearAllBackgroundRunsForTesting(): void {
  runs.clear()
}
