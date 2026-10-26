/**
 * The selector and the reflector as model calls (ADR-0237).
 *
 * The selector sees anonymous runs only (`../select.ts` assigns the seeded
 * ids and decides whether it is consulted at all); the reflector sees the
 * whole run after its decision. Both go through `callHarnessModel`, so both
 * are PII-gated and booked to the run.
 */

import type { Character } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { redactEvidenceText, renderDeliverablesMarkdown, renderRolloutMarkdown } from "../evidence"
import { REFLECTOR_SYSTEM_PROMPT, SELECTOR_SYSTEM_PROMPT, selectorUserPrompt } from "../prompts"
import {
  parseReflection,
  reflectorUserPrompt,
  type ParsedReflection,
  type ReflectionInput,
} from "../reflect"
import { parseJudgeVerdict, type SelectionJudge } from "../select"
import { callHarnessModel, roleModel, type HarnessModelDeps } from "./model-call"
import type { ProbeUsage } from "./probe-runner"

/** Characters of run evidence the selector is given in total. */
export const SELECTOR_MAX_CHARS = 120_000
const SELECTOR_MAX_OUTPUT_TOKENS = 2_000
const REFLECTOR_MAX_OUTPUT_TOKENS = 6_000

function capMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(text.length - (max - head))}`
}

export interface JudgeContext {
  run: Pick<HarnessEvolutionRun, "id" | "task" | "config">
  /** The step's attempt counter, for usage ids. */
  attempt: number
  agent: Pick<Character, "providerId" | "model">
  signal: AbortSignal
  /** Called with each call's usage, success or not. */
  onUsage?(usage: ProbeUsage): void
}

/** The blind selector for one run's final selection. */
export function createSelectionJudge(ctx: JudgeContext, deps: HarnessModelDeps): SelectionJudge {
  let calls = 0
  return async (entries) => {
    calls += 1
    const per = Math.floor(SELECTOR_MAX_CHARS / Math.max(1, entries.length))
    const prompt = selectorUserPrompt(
      redactEvidenceText(ctx.run.task.prompt),
      entries.map((e) => ({
        id: e.id,
        rollout: capMiddle(renderRolloutMarkdown(e.id, e.evidence), Math.floor(per * 0.7)),
        produced: capMiddle(renderDeliverablesMarkdown(e.evidence), Math.floor(per * 0.3)),
      }))
    )
    const answer = await callHarnessModel(
      {
        role: "selector",
        model: roleModel("selector", ctx.run.config.models, ctx.agent),
        system: SELECTOR_SYSTEM_PROMPT,
        prompt,
        maxTokens: SELECTOR_MAX_OUTPUT_TOKENS,
        runId: ctx.run.id,
        operationId: `harness:${ctx.run.id}:select:${ctx.attempt}:${calls}`,
        signal: ctx.signal,
      },
      deps
    )
    ctx.onUsage?.(answer.usage)
    return parseJudgeVerdict(
      answer.text,
      entries.map((e) => e.id)
    )
  }
}

export interface ReflectorOutcome {
  parsed: ParsedReflection | null
  usage: ProbeUsage
  /** Model family of the reflector, recorded on lessons for retrieval. */
  model?: string
}

export async function runReflector(
  ctx: JudgeContext & { reflection: ReflectionInput; labels: readonly string[] },
  deps: HarnessModelDeps
): Promise<ReflectorOutcome> {
  const answer = await callHarnessModel(
    {
      role: "reflector",
      model: roleModel("reflector", ctx.run.config.models, ctx.agent),
      system: REFLECTOR_SYSTEM_PROMPT,
      prompt: reflectorUserPrompt(ctx.reflection),
      maxTokens: REFLECTOR_MAX_OUTPUT_TOKENS,
      runId: ctx.run.id,
      operationId: `harness:${ctx.run.id}:reflect:${ctx.attempt}:1`,
      signal: ctx.signal,
    },
    deps
  )
  ctx.onUsage?.(answer.usage)
  return {
    parsed: parseReflection(answer.text, {
      labels: ctx.labels,
      retrievedIds: ctx.reflection.retrieved.map((e) => e.id),
    }),
    usage: answer.usage,
    ...(answer.model ? { model: answer.model } : {}),
  }
}
