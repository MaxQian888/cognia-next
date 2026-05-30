/**
 * `pattern.completeness-critic` — a final agent that asks "what's missing?":
 * a modality not run, a claim left unverified, a source unread. The gaps it
 * surfaces become the next finder round's input. Without it, a workflow reports
 * what it happened to find as if it were everything.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  critiqueResultSchema,
  type CompletenessCriticParams,
  type Finding,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../structured-dispatch"
import { collectFindings, getTeamCtxOrThrow, nonRetryable, renderFinding } from "./_shared"

const GAPS_HINT = '{ "gaps": [{ "description": "…", "suggestedSearch"?: "…" }] }'

export const COMPLETENESS_CRITIC_KIND = "pattern.completeness-critic" as const

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<CompletenessCriticParams> & { findings?: Finding[] }
  const objective = params.objective?.trim()
  if (!objective) throw nonRetryable("pattern.completeness-critic requires 'objective'")

  const findings =
    params.findings && params.findings.length > 0 ? params.findings : collectFindings(ctx.upstream)

  const findingsBlock =
    findings.length === 0
      ? "(no findings were produced)"
      : findings.map((f) => `- ${renderFinding(f)}`).join("\n")

  ctx.log("info", `completeness-critic: reviewing ${findings.length} findings for gaps`)

  const r = await dispatchStructured(
    teamCtx,
    {
      taskId: `${ctx.stepId}:critic`,
      prompt:
        `Objective: ${objective}\n\n` +
        `The work so far produced these findings:\n${findingsBlock}\n\n` +
        "Acting as a completeness critic, identify what is MISSING — a search angle never run, " +
        "a claim left unverified, a region or source not yet examined. For each gap, optionally " +
        "suggest the concrete next search that would close it. Return an empty list only if you are " +
        "confident the coverage is exhaustive.",
      signal: ctx.signal,
    },
    critiqueResultSchema,
    { schemaHint: GAPS_HINT }
  )

  ctx.log("info", `completeness-critic complete: ${r.value.gaps.length} gaps identified`)
  return { output: { gaps: r.value.gaps } }
}

export const completenessCriticNode: NodeExecutorRegistration = {
  kind: COMPLETENESS_CRITIC_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(completenessCriticNode)
