/**
 * `ai.ensemble` typeVersion 1 — first-class ensemble / N-vote / adversarial-
 * verify node (D6②). Runs a `target` (an inline `agent.turn` config OR a
 * referenced sub-workflow) N times with optional per-sample lenses, then
 * applies a bundled aggregation policy. Output: `{ result, samples[] }`.
 *
 * The pure fan-out + aggregation lives in `lib/ai/ensemble/run-ensemble`
 * (independently testable); this node adapts the workflow
 * `StepExecutionContext` to it: PII gate first (the prompt egresses N×), build
 * the per-sample runner from the target, and wire the optional synthesizer to
 * the routing engine. For an `agent.turn` target with an `outputSchema`, each
 * sample produces a validated typed object (D3) so field-based voting works.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { applyPiiGate, type PiiGateMode } from "./pii-gate"
import { runStructuredTurn } from "./structured-turn"
import {
  runEnsemble,
  type EnsembleAggregation,
  type EnsembleSampleResult,
  type RunEnsembleDeps,
} from "@/lib/ai/ensemble/run-ensemble"

export interface AiEnsembleTarget {
  kind?: "agent.turn" | "subworkflow"
  // agent.turn target:
  systemPrompt?: string
  model?: string
  characterId?: string
  allowedTools?: string[]
  toolsEnabled?: boolean
  /** JSON object schema for typed output (enables field voting). */
  outputSchema?: Record<string, unknown>
  // subworkflow target:
  workflowId?: string
}

export interface AiEnsembleParams {
  prompt?: string
  target?: AiEnsembleTarget
  n?: number
  iterationConcurrency?: number
  lens?: string[]
  aggregation?: EnsembleAggregation
  /** Routing alias for synthesize-by-final-agent. */
  synthesizerAlias?: string
  synthesisInstructions?: string
  timeoutMs?: number
  piiGate?: PiiGateMode
}

/** Low-level primitives the node binds to runEnsemble. Injectable for tests. */
export interface AiEnsembleDeps {
  runAgent: (input: {
    prompt: string
    systemPrompt?: string
    model?: string
    characterId?: string
    allowedTools?: string[]
    toolsEnabled?: boolean
    outputSchema?: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
  }) => Promise<{ text?: string; object?: unknown }>
  runSubworkflow: (input: {
    workflowId: string
    payload: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<{ object: unknown }>
  runPrompt: (input: {
    modelAlias: string
    systemPrompt?: string
    userPrompt: string
    temperature?: number
  }) => Promise<{ completion: string }>
}

const DEFAULT_SYNTH_SYSTEM = `You are an ensemble synthesizer. The same task was attempted several times \
(each attempt is labeled). Merge them into one best answer: integrate the strongest points, resolve \
disagreements with explicit reasoning, and give a single clear final answer.`

/** Format the samples into a synthesizer user message. */
function formatSamplesForSynthesis(samples: EnsembleSampleResult[]): string {
  const blocks = samples.map((s) => {
    const label = s.lens ? `Attempt ${s.index + 1} (${s.lens})` : `Attempt ${s.index + 1}`
    if (s.status !== "completed") return `### ${label}\n(failed: ${s.error ?? "unknown"})`
    const body =
      s.object !== undefined
        ? "```json\n" + JSON.stringify(s.object, null, 2) + "\n```"
        : (s.text ?? "")
    return `### ${label}\n${body}`
  })
  return `Merge the following attempts into one best answer.\n\n${blocks.join("\n\n")}`
}

/** Production deps: executeAgent / runWorkflow / the routing engine. */
export async function defaultAiEnsembleDeps(): Promise<AiEnsembleDeps> {
  const [{ executeAgent }, { getSettings }, { defaultCouncilRunPrompt }] = await Promise.all([
    import("@/lib/ai/agent/agent-executor"),
    import("@/lib/db/settings"),
    import("@/lib/ai/council/run-council"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const providerSnapshot = settings
    ? {
        defaultProvider: settings.defaultProvider,
        providerSettings: settings.providerSettings as NonNullable<
          Parameters<typeof executeAgent>[1]
        >["providerSettings"],
        customProviders: settings.customProviders as NonNullable<
          Parameters<typeof executeAgent>[1]
        >["customProviders"],
      }
    : {}
  const runPrompt = await defaultCouncilRunPrompt()

  return {
    runAgent: async (input) => {
      const base = {
        systemPrompt: input.systemPrompt,
        model: input.model,
        characterId: input.characterId,
        allowedTools: input.allowedTools,
        toolsEnabled: input.toolsEnabled,
        abortSignal: input.signal,
        timeoutMs: input.timeoutMs,
        ...providerSnapshot,
      }
      const schema = input.outputSchema
      if (schema && Object.keys(schema).length > 0) {
        let lastText: string | undefined
        // Soft mode: one malformed sample must not fail the whole ensemble.
        const outcome = await runStructuredTurn({
          outputSchema: schema,
          onSchemaViolation: "soft",
          runOnce: async (fix) => {
            const r = await executeAgent(fix ? `${input.prompt}\n\n${fix}` : input.prompt, {
              ...base,
              outputFormat: { type: "json_schema", schema },
            })
            lastText = r.text
            return { object: r.object, parseError: r.parseError }
          },
        })
        return { text: lastText, object: outcome.object }
      }
      const r = await executeAgent(input.prompt, base)
      return { text: r.text }
    },
    runSubworkflow: async (input) => {
      const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
        import("@/lib/db/workflows"),
        import("@/lib/workflow/runtime/orchestrator"),
      ])
      const workflow = await getWorkflow(input.workflowId)
      if (!workflow) throw new Error(`ai.ensemble: workflow ${input.workflowId} not found`)
      const result = await runWorkflow({
        workflow,
        trigger: {
          workflowId: input.workflowId,
          kind: "trigger.manual",
          payload: input.payload,
          originAt: Date.now(),
        },
        signal: input.signal,
      })
      if (result.status !== "succeeded") {
        throw new Error(`ai.ensemble: sub-workflow ${result.status}`)
      }
      return { object: result.output }
    },
    runPrompt,
  }
}

export async function executeAiEnsemble(
  ctx: StepExecutionContext,
  depsFactory: () => Promise<AiEnsembleDeps> = defaultAiEnsembleDeps
): Promise<StepExecutionResult> {
  const params = ctx.params as AiEnsembleParams
  const target = params.target ?? {}
  const targetKind = target.kind ?? "agent.turn"
  const n = Math.floor(params.n ?? 3)
  if (!Number.isFinite(n) || n < 1) {
    throw nonRetryable("ai.ensemble: 'n' must be ≥ 1")
  }
  const aggregation = params.aggregation
  if (!aggregation?.kind) {
    throw nonRetryable("ai.ensemble: an 'aggregation' policy is required")
  }
  if (aggregation.kind === "synthesize-by-final-agent" && !params.synthesizerAlias) {
    throw nonRetryable("ai.ensemble: synthesize-by-final-agent requires a 'synthesizerAlias'")
  }

  // PII gate FIRST — the prompt egresses to every sample.
  const gated = applyPiiGate(params.piiGate, {
    system: target.systemPrompt,
    user: params.prompt ?? "",
  })
  if (targetKind === "agent.turn" && !gated.user.trim()) {
    throw nonRetryable("ai.ensemble: a non-empty 'prompt' is required for an agent.turn target")
  }
  if (targetKind === "subworkflow" && !target.workflowId?.trim()) {
    throw nonRetryable("ai.ensemble: a 'target.workflowId' is required for a subworkflow target")
  }

  const deps = await depsFactory()

  const runSample: RunEnsembleDeps["runSample"] = async ({ index, lens }) => {
    if (targetKind === "subworkflow") {
      return deps.runSubworkflow({
        workflowId: target.workflowId!.trim(),
        payload: {
          prompt: gated.user,
          ...(lens ? { lens } : {}),
          index,
          parentRunId: ctx.runId,
          parentStepId: ctx.stepId,
        },
        signal: ctx.signal,
      })
    }
    // agent.turn: a lens steers this sample's perspective.
    const prompt = lens ? `${lens}\n\n---\n\n${gated.user}` : gated.user
    return deps.runAgent({
      prompt,
      systemPrompt: gated.system,
      model: target.model,
      characterId: target.characterId,
      allowedTools: target.allowedTools,
      toolsEnabled: target.toolsEnabled,
      outputSchema: target.outputSchema,
      timeoutMs: params.timeoutMs,
      signal: ctx.signal,
    })
  }

  const synthesize: RunEnsembleDeps["synthesize"] =
    aggregation.kind === "synthesize-by-final-agent"
      ? async (samples, instructions) => {
          const system = instructions
            ? `${DEFAULT_SYNTH_SYSTEM}\n\nAdditional guidance:\n${instructions}`
            : DEFAULT_SYNTH_SYSTEM
          const out = await deps.runPrompt({
            modelAlias: params.synthesizerAlias!,
            systemPrompt: system,
            userPrompt: formatSamplesForSynthesis(samples),
            temperature: 0.1,
          })
          return { text: (out.completion ?? "").trim() }
        }
      : undefined

  const result = await runEnsemble(
    {
      n,
      ...(params.lens && params.lens.length > 0 ? { lens: params.lens } : {}),
      aggregation,
      ...(params.iterationConcurrency ? { iterationConcurrency: params.iterationConcurrency } : {}),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    },
    {
      runSample,
      ...(synthesize ? { synthesize } : {}),
      log: (level, message) => ctx.log(level, message),
    }
  )

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
