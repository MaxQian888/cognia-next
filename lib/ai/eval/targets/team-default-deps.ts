/**
 * Real desktop wiring for the Agent Team eval target. Drives
 * `runTeamLifecycle` against the live team store (the eval case's prompt
 * overrides the team objective for the run), threading the run-scoped
 * `traceId` so every teammate dispatch emits its span under it. Spans are read
 * back by trace via `queryByTrace`. Mirrors `action.team.run`'s store wiring.
 */

import { queryByTrace } from "@/lib/db/agent-traces"
import type { TeamTargetDeps } from "./team"

/** Pull a human-readable final text from the team run's terminal output. */
export function extractTeamText(output: unknown): string {
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const report = (output as { report?: unknown }).report
    if (typeof report === "string") return report
    return JSON.stringify(output)
  }
  return ""
}

export function defaultTeamTargetDeps(): TeamTargetDeps {
  return {
    async runTeam({ teamId, prompt, traceId, timeoutMs, signal }) {
      const [{ useAgentTeamStore }, { runTeamLifecycle }, { buildAgentTeamRuntimeDeps }] =
        await Promise.all([
          import("@/stores/agent/agent-team-store"),
          import("@/lib/ai/agent/agent-team-runtime"),
          import("@/lib/ai/agent/agent-team-runtime-deps"),
        ])
      void timeoutMs // per-task timeouts are governed by team.config; reserved for parity
      const partial = buildAgentTeamRuntimeDeps()
      const result = await runTeamLifecycle(
        teamId,
        {
          ...partial,
          traceId,
          storeReader: {
            // Override the team objective with the eval case's prompt so the
            // same team can be scored against many cases.
            getTeam: (id: string) => {
              const team = useAgentTeamStore.getState().getTeam(id)
              return team ? { ...team, task: prompt } : team
            },
            getTeammates: (id: string) => useAgentTeamStore.getState().getTeammates(id),
            getTeamTasks: (id: string) => useAgentTeamStore.getState().getTeamTasks(id),
          },
          storeWriter: {
            addMessage: (input) => useAgentTeamStore.getState().addMessage(input),
            setTaskStatus: (taskId, status, taskResult, error) =>
              useAgentTeamStore.getState().setTaskStatus(taskId, status, taskResult, error),
            updateTeammate: (teammateId, updates) =>
              useAgentTeamStore.getState().updateTeammate(teammateId, updates),
          },
        },
        signal
      )
      return {
        runId: result.runId,
        status: result.status,
        text: extractTeamText(result.output),
        traceId,
      }
    },
    fetchSpansByTrace: (traceId: string) => queryByTrace(traceId),
    isToolCapable() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("@/lib/tauri") as { isTauri: () => boolean }
        return mod.isTauri()
      } catch {
        return false
      }
    },
  }
}
