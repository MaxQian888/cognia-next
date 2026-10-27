/** Isolated text evaluation wiring. Real Squad state is never used as scratch. */
import { queryByTrace } from "@/lib/db/agent-traces"
import type { TeamTargetDeps } from "./team"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import Dexie from "dexie"
import { waitForEvalTracePersistence } from "./trace-persistence"

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
    async runTeam(input) {
      const assertActive = () => {
        scope?.assertActive()
        input.signal?.throwIfAborted()
      }
      assertActive()
      const { runIsolatedTeamEval } = await import("@/lib/ai/eval/team-execution")
      assertActive()
      const result = await runIsolatedTeamEval({ ...input, ...(scope ? { scope } : {}) })
      scope?.assertActive()
      return { ...result, text: extractTeamText(result.output), executionProfile: "isolated-text" }
    },
    async fetchSpansByTrace(traceId: string) {
      scope?.assertActive()
      await waitForEvalTracePersistence()
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
    isToolCapable: () => false,
  }
}
