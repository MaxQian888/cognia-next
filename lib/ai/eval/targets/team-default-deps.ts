/**
 * Real desktop wiring for the Agent Team eval target. Drives
 * `runTeamLifecycle` against the live team store (the eval case's prompt
 * overrides the team objective for the run), threading the run-scoped
 * `traceId` so every teammate dispatch emits its span under it. Spans are read
 * back by trace via `queryByTrace`. Mirrors `action.team.run`'s store wiring.
 */

import { queryByTrace } from "@/lib/db/agent-traces"
import type { TeamTargetDeps } from "./team"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import Dexie from "dexie"

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

export function defaultTeamTargetDeps(scope?: EvalPersistenceScope): TeamTargetDeps {
  return {
    async runTeam({ teamId, prompt, traceId, timeoutMs, signal }) {
      const assertActive = () => {
        scope?.assertActive()
        signal?.throwIfAborted()
      }
      assertActive()
      const [{ useAgentTeamStore }, { runTeamLifecycle }, { buildAgentTeamRuntimeDeps }] =
        await Promise.all([
          import("@/stores/agent/agent-team-store"),
          import("@/lib/ai/agent/team/agent-team-runtime"),
          import("@/lib/ai/agent/team/agent-team-runtime-deps"),
        ])
      assertActive()
      void timeoutMs // per-task timeouts are governed by team.config; reserved for parity
      const execution = scope ? await import("@/lib/ai/agent/agent-executor") : undefined
      assertActive()
      const partial = buildAgentTeamRuntimeDeps(
        execution
          ? {
              executeAgent: (input, config) => {
                assertActive()
                config?.abortSignal?.throwIfAborted()
                return execution.executeAgent(input, config)
              },
              readSettings: async () => {
                assertActive()
                const { getSettings } = await import("@/lib/db/settings")
                assertActive()
                const settings = await getSettings(scope)
                assertActive()
                return settings
              },
            }
          : undefined
      )
      const result = await runTeamLifecycle(
        teamId,
        {
          ...partial,
          traceId,
          storeReader: {
            // Override the team objective with the eval case's prompt so the
            // same team can be scored against many cases.
            getTeam: (id: string) => {
              assertActive()
              const team = useAgentTeamStore.getState().getTeam(id)
              return team ? { ...team, task: prompt } : team
            },
            getTeammates: (id: string) => {
              assertActive()
              return useAgentTeamStore.getState().getTeammates(id)
            },
            getTeamTasks: (id: string) => {
              assertActive()
              return useAgentTeamStore.getState().getTeamTasks(id)
            },
          },
          storeWriter: {
            addMessage: (input) => {
              assertActive()
              return useAgentTeamStore.getState().addMessage(input)
            },
            setTaskStatus: (taskId, status, taskResult, error) => {
              assertActive()
              return useAgentTeamStore.getState().setTaskStatus(taskId, status, taskResult, error)
            },
            updateTeammate: (teammateId, updates) => {
              assertActive()
              return useAgentTeamStore.getState().updateTeammate(teammateId, updates)
            },
          },
        },
        signal
      )
      assertActive()
      return {
        runId: result.runId,
        status: result.status,
        text: extractTeamText(result.output),
        traceId,
      }
    },
    async fetchSpansByTrace(traceId: string) {
      scope?.assertActive()
      const spans = await (scope
        ? scope.db.agentTraces
            .where("[traceId+startTime]")
            .between([traceId, Dexie.minKey], [traceId, Dexie.maxKey])
            .toArray()
        : queryByTrace(traceId))
      scope?.assertActive()
      return spans
    },
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
