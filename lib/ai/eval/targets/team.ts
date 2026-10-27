/**
 * Agent Team eval target — drives a team run for a case and assembles the
 * captured trajectory into an {@link EvalSample}.
 *
 * Team runs span multiple sessions (one per teammate dispatch), so the target
 * threads a run-scoped `traceId` into isolated execution and receives settled
 * spans through a run-owned capture sink. Persisted trace reads are only a
 * compatibility fallback. The pure `assembleSampleFromSpans` is reused;
 * real isolated wiring lives in `team-default-deps.ts`.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase, EvalSample } from "@/types/eval/eval"
import type { EvalTarget } from "@cognia/eval-core"
import { assembleSampleFromSpans, renderEvalTextPrompt } from "./chat"
import { newEvalTraceId } from "./span-scope"
import { createEvalDeadline } from "./deadline"

export interface TeamTargetConfig {
  label: string
  teamId: string
  timeoutMs?: number
  maxCostUsd?: number
  price?: { inputPerMillion: number; outputPerMillion: number; currency: string }
}

export interface TeamTargetDeps {
  /** Run the team for one prompt under the given run-scoped trace id. */
  runTeam(input: {
    teamId: string
    prompt: string
    traceId: string
    timeoutMs?: number
    maxCostUsd?: number
    price?: { inputPerMillion: number; outputPerMillion: number; currency: string }
    signal?: AbortSignal
    /** Run-owned capture retains settled spend even when a later call times out. */
    onSpan?: (span: AgentTraceSpan) => void
  }): Promise<{
    runId: string
    status: string
    text: string
    traceId: string
    reason?: string
    spans?: AgentTraceSpan[]
    wallTimeMs?: number
    costKnown?: boolean
    executionProfile?: "isolated-text"
  }>
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
      const startedAt = Date.now()
      const deadline = createEvalDeadline(signal, config.timeoutMs)
      let output = ""
      let capturedSpans: AgentTraceSpan[] = []
      let status: NonNullable<EvalSample["executionStatus"]> = "completed"
      let error: string | undefined
      let costKnown: boolean | undefined
      let executionProfile: "isolated-text" | undefined
      try {
        const prompt = renderEvalTextPrompt(evalCase)
        const result = await deadline.run(() =>
          deps.runTeam({
            teamId: config.teamId,
            prompt,
            traceId,
            ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
            ...(config.maxCostUsd !== undefined ? { maxCostUsd: config.maxCostUsd } : {}),
            ...(config.price ? { price: config.price } : {}),
            signal: deadline.signal,
            onSpan: (span) => {
              capturedSpans.push(span)
            },
          })
        )
        output = result.text
        capturedSpans =
          result.spans ??
          (capturedSpans.length
            ? capturedSpans
            : await deadline.run(() => deps.fetchSpansByTrace(traceId)))
        costKnown = result.costKnown
        executionProfile = result.executionProfile
        const reported = result.status
        status =
          reported === "completed"
            ? "completed"
            : reported === "cancelled"
              ? "cancelled"
              : reported === "timed_out"
                ? "timed_out"
                : reported === "interrupted"
                  ? "interrupted"
                  : ["blocked", "needs_input", "paused", "not_ready"].includes(reported)
                    ? "blocked"
                    : "failed"
        if (status !== "completed") error = result.reason ?? `Team evaluation ${status}`
      } catch (caught) {
        costKnown = false
        error = caught instanceof Error ? caught.message : String(caught)
        const timedOut = deadline.signal.aborted && deadline.signal.reason?.name === "TimeoutError"
        status = timedOut
          ? "timed_out"
          : deadline.signal.aborted
            ? "cancelled"
            : /does not support asset/.test(error)
              ? "blocked"
              : "failed"
      } finally {
        deadline.dispose()
      }
      const sample = assembleSampleFromSpans(capturedSpans, {
        output,
        degraded: !deps.isToolCapable(),
        wallTimeMs: Math.max(0, Date.now() - startedAt),
      })
      if (costKnown === false && sample.metricAvailability) {
        sample.metricAvailability.cost =
          sample.metricAvailability.cost === "unavailable" ? "unavailable" : "partial"
      }
      return {
        ...sample,
        executionStatus: status,
        ...(executionProfile ? { executionProfile } : {}),
        ...(error ? { error } : {}),
      }
    },
  }
}
