"use client"

/**
 * Run-scoped bookkeeping for terminal sessions opened by workflow nodes
 * (`action.terminal.session.open`). Whatever a run opens — headless
 * private PTYs or visible dock tabs — is recorded here so the workflow
 * orchestrator can close everything deterministically when the run ends
 * (success OR failure), no matter how the graph terminated.
 *
 * Module-level singleton (mirrors `lib/terminal/session-registry.ts`):
 * workflow execution is renderer-local today, so a Map is sufficient.
 */

export type RunSessionMode = "dock" | "headless"

interface RunSessionEntry {
  sessionId: string
  mode: RunSessionMode
}

const byRun = new Map<string, RunSessionEntry[]>()

/** Record a session opened by `runId`. */
export function registerRunSession(runId: string, sessionId: string, mode: RunSessionMode): void {
  const list = byRun.get(runId) ?? []
  if (!list.some((e) => e.sessionId === sessionId)) {
    list.push({ sessionId, mode })
  }
  byRun.set(runId, list)
}

/** Sessions currently registered for `runId` (open order). */
export function listRunSessions(runId: string): ReadonlyArray<RunSessionEntry> {
  return byRun.get(runId) ?? []
}

/** Remove one session from the run's ledger (explicit node close). */
export function deregisterRunSession(runId: string, sessionId: string): void {
  const list = byRun.get(runId)
  if (!list) return
  const next = list.filter((e) => e.sessionId !== sessionId)
  if (next.length === 0) {
    byRun.delete(runId)
  } else {
    byRun.set(runId, next)
  }
}

/**
 * Close every session the run still holds. Best-effort: each close is
 * isolated so one failure can't leak the rest, and the ledger entry is
 * dropped regardless. Safe to call for runs that never opened a session
 * and safe to call twice.
 */
export async function closeRunSessions(runId: string): Promise<void> {
  const list = byRun.get(runId)
  byRun.delete(runId)
  if (!list || list.length === 0) return
  for (const entry of list) {
    try {
      if (entry.mode === "headless") {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("terminal_headless_kill", { sessionId: entry.sessionId })
      } else {
        const [{ killFromDock }, { useTerminalStore }] = await Promise.all([
          import("./spawn-orchestrator"),
          import("@/stores/terminal/terminal-store"),
        ])
        await killFromDock(entry.sessionId, useTerminalStore.getState())
      }
    } catch {
      // Best-effort cleanup — a dead backend or an already-closed session
      // must never mask the run's own result.
    }
  }
}

/** Test-only: reset the ledger between cases. */
export function __clearRunSessionsForTesting(): void {
  byRun.clear()
}
