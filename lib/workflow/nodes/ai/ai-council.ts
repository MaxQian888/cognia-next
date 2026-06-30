/**
 * `ai.council` typeVersion 1 — multi-model consensus node. Fans the node's
 * prompt out to several councillor models (by routing alias) in parallel, then
 * a synthesizer model merges them into one answer with a confidence rating.
 *
 * Logic lives in `lib/ai/council/run-council` (shared with the `/council`
 * slash command) so it is independently testable; this node only adapts the
 * workflow `StepExecutionContext` to it: PII gate first (every prompt egresses
 * to multiple providers), emit the synthesized report to the run stream, and
 * surface the structured result as the node output.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { applyPiiGate, type PiiGateMode } from "./pii-gate"
import {
  runCouncil,
  defaultCouncilRunPrompt,
  type CouncillorSpec,
  type RunCouncilDeps,
} from "@/lib/ai/council/run-council"

export interface AiCouncilParams {
  prompt?: string
  councillors?: CouncillorSpec[]
  synthesizerAlias?: string
  synthesisInstructions?: string
  timeoutMs?: number
  executionMode?: "parallel" | "serial"
  maxConcurrency?: number
  piiGate?: PiiGateMode
}

/** Build production deps lazily (routing engine). Injectable for tests. */
export async function defaultAiCouncilDeps(): Promise<RunCouncilDeps> {
  return { runPrompt: await defaultCouncilRunPrompt() }
}

export async function executeAiCouncil(
  ctx: StepExecutionContext,
  depsFactory: () => Promise<RunCouncilDeps> = defaultAiCouncilDeps
): Promise<StepExecutionResult> {
  const params = ctx.params as AiCouncilParams
  const councillors = (params.councillors ?? []).filter(
    (c): c is CouncillorSpec =>
      !!c && typeof c.modelAlias === "string" && typeof c.name === "string"
  )
  if (councillors.length === 0) {
    throw nonRetryable("ai.council: at least one councillor { name, modelAlias } is required")
  }
  if (!params.synthesizerAlias) {
    throw nonRetryable("ai.council: a synthesizerAlias is required")
  }

  // PII gate FIRST — the prompt egresses to every councillor + the synthesizer.
  const gated = applyPiiGate(params.piiGate, { system: undefined, user: params.prompt ?? "" })
  if (!gated.user.trim()) {
    throw nonRetryable("ai.council: a non-empty prompt is required")
  }

  const deps = await depsFactory()
  const depsWithLog: RunCouncilDeps = {
    ...deps,
    log: (level, message) => ctx.log(level, message),
  }

  const result = await runCouncil(
    {
      prompt: gated.user,
      councillors,
      synthesizerAlias: params.synthesizerAlias,
      synthesisInstructions: params.synthesisInstructions,
      timeoutMs: params.timeoutMs,
      executionMode: params.executionMode,
      maxConcurrency: params.maxConcurrency,
    },
    depsWithLog
  )

  // Surface the synthesized report in the run stream (one shot — the synthesis
  // itself is not delta-streamed).
  ctx.emitStream?.(result.markdown)

  return {
    output: {
      ...result,
      ...(gated.redacted ? { piiRedacted: true } : {}),
    },
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable: boolean }
  err.retryable = false
  return err
}
