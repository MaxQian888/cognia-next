/**
 * `pattern.synthesize` — the final artifact. A dedicated synthesizer subagent
 * folds the surviving (verified) findings, the judge-panel winner, and any
 * outstanding completeness gaps into one cited report. The report is posted to
 * the team chat as a `result_share` message; the run also returns it so
 * `runTeamLifecycle` can write it to `team.finalResult`.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  synthesisReportSchema,
  type CritiqueGap,
  type Finding,
  type RankedAttemptLike,
  type SynthesizeParams,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../teammate/structured-dispatch"
import {
  collectFindings,
  collectUpstreamArray,
  firstUpstream,
  getTeamCtxOrThrow,
  nonRetryable,
  renderFinding,
} from "./_shared"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  freezePatternPromptScope,
  SYNTHESIZE_REPORT_PROMPT,
  SYNTHESIZE_REPORT_SCHEMA_HINT_PROMPT,
} from "./pattern-prompts"

export const SYNTHESIZE_KIND = "pattern.synthesize" as const

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<SynthesizeParams>
  const objective = params.objective?.trim()
  if (!objective) throw nonRetryable("pattern.synthesize requires 'objective'")

  const findings = collectFindings(ctx.upstream)
  const winner = firstUpstream<RankedAttemptLike>(ctx.upstream, "winner")
  const gaps = collectUpstreamArray<CritiqueGap>(ctx.upstream, "gaps")

  const findingsBlock =
    findings.length > 0
      ? `Verified findings:\n${findings.map((f: Finding) => `- ${renderFinding(f)}`).join("\n")}`
      : "No verified findings."
  const winnerBlock = winner?.attempt
    ? `\n\nWinning approach (angle: ${winner.attempt.angle}):\n${winner.attempt.content}`
    : ""
  const gapsBlock =
    gaps.length > 0
      ? `\n\nKnown open gaps (call these out as limitations):\n${gaps.map((g) => `- ${g.description}`).join("\n")}`
      : ""

  ctx.log(
    "info",
    `synthesize: folding ${findings.length} findings${winner ? " + judge winner" : ""}${gaps.length ? ` + ${gaps.length} gaps` : ""}`
  )

  // Resolved once for this step (ADR-0236).
  const promptScope = await freezePatternPromptScope(teamCtx)
  ctx.signal?.throwIfAborted()
  const r = await dispatchStructured(
    teamCtx,
    {
      taskId: `${ctx.stepId}:synthesize`,
      prompt: resolvePrompt(SYNTHESIZE_REPORT_PROMPT, {
        ...promptScope,
        values: { objective, findingsBlock, winnerBlock, gapsBlock },
      }).text,
      signal: ctx.signal,
    },
    synthesisReportSchema,
    { schemaHint: resolvePrompt(SYNTHESIZE_REPORT_SCHEMA_HINT_PROMPT).text }
  )

  // Surface the report in the team chat.
  teamCtx.storeWriter.addMessage({
    teamId: teamCtx.teamId,
    senderId: r.teammateId,
    type: "result_share",
    content: r.value.report.length > 4000 ? `${r.value.report.slice(0, 3999)}…` : r.value.report,
  })

  ctx.log(
    "info",
    `synthesize complete: ${r.value.report.length} chars, ${r.value.citations?.length ?? 0} citations`
  )
  return {
    output: {
      report: r.value.report,
      citations: r.value.citations ?? [],
      findingCount: findings.length,
    },
  }
}

export const synthesizeNode: NodeExecutorRegistration = {
  kind: SYNTHESIZE_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(synthesizeNode)
