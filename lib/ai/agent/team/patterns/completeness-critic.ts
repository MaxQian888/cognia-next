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
import { dispatchStructured } from "../teammate/structured-dispatch"
import { collectFindings, getTeamCtxOrThrow, nonRetryable, renderFinding } from "./_shared"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  CRITIC_GAPS_SCHEMA_HINT_PROMPT,
  CRITIC_PROMPT,
  freezePatternPromptScope,
} from "./pattern-prompts"

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

  // Resolved once for this step (ADR-0236).
  const promptScope = await freezePatternPromptScope(teamCtx)
  ctx.signal?.throwIfAborted()
  const r = await dispatchStructured(
    teamCtx,
    {
      taskId: `${ctx.stepId}:critic`,
      prompt: resolvePrompt(CRITIC_PROMPT, {
        ...promptScope,
        values: { objective, findings: findingsBlock },
      }).text,
      signal: ctx.signal,
    },
    critiqueResultSchema,
    { schemaHint: resolvePrompt(CRITIC_GAPS_SCHEMA_HINT_PROMPT).text }
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
