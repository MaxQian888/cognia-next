/**
 * Agent Team eval target — drives a team run for a case and assembles the
 * captured trajectory into an {@link EvalSample}.
 *
 * Team runs span multiple sessions (one per teammate dispatch), so the target
 * threads a run-scoped `traceId` into the run and reads spans back by trace
 * (`queryByTrace`) rather than by session. The pure `assembleSampleFromSpans`
 * is reused. Dependency-injected for unit-testability; the real wiring
 * (`runTeamLifecycle` + `queryByTrace`) lives in `team-default-deps.ts`.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase, EvalSample } from "@/types/eval/eval"
import type { EvalTarget } from "@cognia/eval-core"
import { assembleSampleFromSpans } from "./chat"
import { newEvalTraceId } from "./span-scope"

export interface TeamTargetConfig {
  label: string
  teamId: string
  timeoutMs?: number
}

export interface TeamTargetDeps {
  /** Run the team for one prompt under the given run-scoped trace id. */
  runTeam(input: {
    teamId: string
    prompt: string
    traceId: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string; status: string; text: string; traceId: string }>
  /** Fetch every span emitted under a trace id. */
  fetchSpansByTrace(traceId: string): Promise<AgentTraceSpan[]>
  /** Whether the tool-enabled (sidecar) path is available. */
  isToolCapable(): boolean
}

export function createTeamTarget(config: TeamTargetConfig, deps: TeamTargetDeps): EvalTarget {
  return {
    label: config.label,
    async run(evalCase: EvalCase, signal?: AbortSignal): Promise<EvalSample> {
      const traceId = newEvalTraceId()
      const { text } = await deps.runTeam({
        teamId: config.teamId,
        prompt: evalCase.input,
        traceId,
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      })
      const spans = await deps.fetchSpansByTrace(traceId)
      return assembleSampleFromSpans(spans, { output: text, degraded: !deps.isToolCapable() })
    },
  }
}
