/**
 * CLI background subagent run registry.
 *
 * When `dispatch_agent` is called with `background: true`, the CLI starts the
 * subagent over the live sidecar but returns a runId immediately instead of
 * blocking the dispatching turn. The in-flight, already-formatted result string
 * is parked here keyed by runId; the model collects it later (often in a LATER
 * turn) via `dispatch_agent({ collect: runId })`.
 *
 * Why a module-level registry rather than the per-turn dispatch context: the
 * dispatch context (gate / signal / agents) is published at the head of each
 * turn and CLEARED when the turn settles. A backgrounded run, however, must
 * outlive the spawning turn so its result can be collected later. The parked
 * promise holds its own closures (it captured the turn's gate/signal at dispatch
 * time — and the turn's AbortSignal is only fired on user interrupt, never on
 * normal completion), so the run keeps progressing after the context is gone.
 *
 * Unlike the renderer's `lib/claude/agents/background-registry.ts` (which parks
 * a structured `PluginSubagentDispatchResult`), the CLI parks the already-shaped
 * tool-result string the dispatch handler builds, so collection is a plain
 * string read. Pure module — no I/O, self-contained promise lifecycle.
 */

export type CliBackgroundRunStatus = "running" | "done" | "error"

interface Entry {
  promise: Promise<string>
  status: CliBackgroundRunStatus
  /** The settled result string (success text or error message); set on settle. */
  result?: string
  subagentId: string
  startedAt: number
}

const runs = new Map<string, Entry>()

/**
 * Park a background run. The promise (a never-rejecting formatted result string;
 * the dispatch handler collapses failures onto a readable line) is tracked so a
 * later `collect` can await — or, once settled, synchronously read — its
 * outcome. Status flips to `done`/`error` when it settles so the TUI can surface
 * progress without awaiting.
 */
export function startCliBackgroundRun(
  runId: string,
  subagentId: string,
  promise: Promise<string>,
  now: number = Date.now()
): void {
  const entry: Entry = { promise, status: "running", subagentId, startedAt: now }
  runs.set(runId, entry)
  promise.then(
    (r) => {
      entry.status = "done"
      entry.result = r
    },
    (err) => {
      entry.status = "error"
      entry.result = err instanceof Error ? err.message : String(err)
    }
  )
}

/** Whether a background run id is known (in-flight or settled, not yet collected). */
export function hasCliBackgroundRun(runId: string): boolean {
  return runs.has(runId)
}

/**
 * Await (or read) a background run's result and drop the entry. Returns
 * `undefined` for an unknown id (already collected or never started). A rejected
 * run resolves to its error message so the caller always has a string to surface.
 */
export async function collectCliBackgroundResult(runId: string): Promise<string | undefined> {
  const entry = runs.get(runId)
  if (!entry) return undefined
  try {
    const result = await entry.promise
    runs.delete(runId)
    return result
  } catch (err) {
    runs.delete(runId)
    return err instanceof Error ? err.message : String(err)
  }
}

/** A background run's at-a-glance status, for TUI/footer surfacing. */
export interface CliBackgroundRunInfo {
  runId: string
  subagentId: string
  status: CliBackgroundRunStatus
  startedAt: number
}

/** Snapshot the currently-parked (uncollected) background runs. */
export function listCliBackgroundRuns(): CliBackgroundRunInfo[] {
  return [...runs.entries()].map(([runId, e]) => ({
    runId,
    subagentId: e.subagentId,
    status: e.status,
    startedAt: e.startedAt,
  }))
}

/** Count of parked runs still in flight (status === "running"). */
export function countRunningCliBackgroundRuns(): number {
  let n = 0
  for (const e of runs.values()) if (e.status === "running") n += 1
  return n
}

/** Test-only: drop all parked runs so suites don't bleed state into each other. */
export function __clearAllCliBackgroundRunsForTesting(): void {
  runs.clear()
}
