/**
 * `pattern.multi-modal-sweep` — parallel finders, each searching a different
 * way (by-container, by-content, by-entity, by-time, …). Each finder is blind
 * to what the others surface, so one search angle's blind spot is covered by
 * another. Returns the deduped union of all findings.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  findingsResultSchema,
  type Finding,
  type MultiModalSweepParams,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../teammate/structured-dispatch"
import {
  assignFindingIds,
  dedupeFindings,
  fanoutLimit,
  getTeamCtxOrThrow,
  mapSettled,
  nonRetryable,
} from "./_shared"
import { resolvePrompt } from "@/lib/prompts/resolve"
import {
  FINDINGS_SCHEMA_HINT_PROMPT,
  freezePatternPromptScope,
  SWEEP_FINDER_PROMPT,
} from "./pattern-prompts"

export const MULTI_MODAL_SWEEP_KIND = "pattern.multi-modal-sweep" as const

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<MultiModalSweepParams>
  const objective = params.objective?.trim()
  const modalities = (params.modalities ?? []).map((m) => m?.trim()).filter((m): m is string => !!m)
  if (!objective) throw nonRetryable("pattern.multi-modal-sweep requires 'objective'")
  if (modalities.length === 0) {
    throw nonRetryable("pattern.multi-modal-sweep requires at least one 'modalities' entry")
  }

  ctx.log("info", `multi-modal sweep: ${modalities.length} parallel finders`)
  // One snapshot for the whole step (ADR-0236), so every finder reads the same text.
  const promptScope = await freezePatternPromptScope(teamCtx)
  ctx.signal?.throwIfAborted()
  const findingsHint = resolvePrompt(FINDINGS_SCHEMA_HINT_PROMPT).text

  const results = await mapSettled(
    modalities,
    fanoutLimit(teamCtx),
    async (modality, i) => {
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:sweep:${i}`,
          prompt: resolvePrompt(SWEEP_FINDER_PROMPT, {
            ...promptScope,
            values: { objective, modality },
          }).text,
          signal: ctx.signal,
        },
        findingsResultSchema,
        { schemaHint: findingsHint }
      )
      ctx.log("info", `sweep finder ${i} (${modality}) → ${r.value.findings.length} findings`)
      return r.value.findings
    },
    (err, _modality, i) => ctx.log("warn", `sweep finder ${i} failed: ${String(err)}`)
  )

  const flat = results.filter((x): x is Finding[] => x !== null).flat()
  const findings = dedupeFindings(assignFindingIds(flat))
  ctx.log("info", `multi-modal sweep complete: ${findings.length} unique findings`)

  return { output: { findings, finderCount: modalities.length } }
}

export const multiModalSweepNode: NodeExecutorRegistration = {
  kind: MULTI_MODAL_SWEEP_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(multiModalSweepNode)
