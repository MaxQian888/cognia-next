/**
 * Public surface of the twin distill subsystem.
 */

import { createTwinJob } from "@/lib/db/twin-jobs"
import type { TwinJob } from "@/types/twin"

export type { LlmClient, LlmClientCallOptions, AnthropicLlmConfig } from "./llm"
export { createAnthropicLlmClient, extractJson } from "./llm"

export type { OrchestratorInput, OrchestratorOutput } from "./orchestrator"
export { runOrchestrator } from "./orchestrator"

export type { RunDistillInput, RunDistillResult } from "./job-runner"
export { runDistillJob } from "./job-runner"

export type { StyleAgentInput, StyleAgentResult } from "./agents/style-agent"
export { runStyleAgent } from "./agents/style-agent"
export type { PlaybookAgentInput, PlaybookAgentResult } from "./agents/playbook-agent"
export { runPlaybookAgent } from "./agents/playbook-agent"
export type { KnowledgeAgentInput, KnowledgeAgentResult } from "./agents/knowledge-agent"
export { runKnowledgeAgent } from "./agents/knowledge-agent"
export type { SynthesizerInput, SynthesizerResult, SynthDraft } from "./agents/synthesizer"
export { runSynthesizer } from "./agents/synthesizer"
export type { EvaluatorInput, EvaluatorResult } from "./agents/evaluator"
export { runEvaluator } from "./agents/evaluator"

/**
 * Queue a distill job for the worker to pick up. Caller passes the source
 * scope (empty array = "every chunk for this twin").
 */
export async function enqueueDistillJob(
  twinId: string,
  options: { sourceIds?: string[]; reDistill?: boolean } = {}
): Promise<TwinJob> {
  return createTwinJob({
    twinId,
    kind: options.reDistill ? "re-distill" : "distill",
    sourceIds: options.sourceIds ?? [],
  })
}
