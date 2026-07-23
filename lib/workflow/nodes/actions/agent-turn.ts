/**
 * `action.agent.turn` — run one full agent turn as a workflow step.
 *
 * Desktop (Tauri): rides the tool-enabled sidecar pipeline (`executeAgent`
 * with `toolsEnabled`), so the agent can call Bash/Read/Edit/plugin/MCP
 * tools subject to the existing per-tool approval gate and the
 * character's `allowedTools`. Web/mobile: degrades to a text-only
 * completion and reports `toolsAvailable: false` honestly — set
 * `requireTools: true` to fail instead of degrading.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  runStructuredTurn,
  type SchemaViolationMode,
} from "@/lib/workflow/nodes/ai/structured-turn"
import type { ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"

export interface AgentTurnParams {
  prompt?: string
  /** Run as an existing persona (its prompt/model/tools/skills apply). */
  characterId?: string
  /** Used when no characterId — synthesised into an ephemeral persona. */
  systemPrompt?: string
  model?: string
  /** Restrict the tool surface of the synthesised persona. */
  allowedTools?: string[]
  /** Upper bound on agent steps (text channel's AI-SDK maxSteps). */
  maxTurns?: number
  temperature?: number
  /** Wall-clock cap for the turn. Default 600s. */
  timeoutMs?: number
  /** Ask for the tool-enabled pipeline (default true). */
  toolsEnabled?: boolean
  /** Fail (non-retryable) instead of degrading when tools are unavailable. */
  requireTools?: boolean
  /** Working directory the tool-enabled run is scoped to. */
  cwd?: string
  /**
   * Optional JSON object schema the turn's output must satisfy (D3). When set,
   * the turn parses + validates its reply, performs one bounded auto-fix retry
   * on violation, and surfaces a validated `object` alongside `text`.
   */
  outputSchema?: Record<string, unknown>
  /**
   * Behaviour when the output still violates the schema after the auto-fix
   * retry. `"fail"` (default) throws into the node's errorPolicy; `"soft"`
   * returns the unvalidated object with `schemaValid: false`.
   */
  onSchemaViolation?: SchemaViolationMode
}

const DEFAULT_TIMEOUT_MS = 600_000

/** Pinned copy — asserted by tests; the service path must fail with the same words. */
const REQUIRE_TOOLS_UNAVAILABLE_MESSAGE =
  "action.agent.turn: tools required but the desktop sidecar is unavailable " +
  "(web/mobile run). Unset 'requireTools' to allow the text-only fallback."

export async function runAgentTurn(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as AgentTurnParams
  const prompt = (params.prompt ?? "").trim()
  if (!prompt) {
    throw nonRetryable("action.agent.turn requires a non-empty 'prompt'")
  }
  const toolsEnabled = params.toolsEnabled !== false

  // ADR-0090 Phase 6: behind the resolver flag the unified service owns rail
  // selection and the requireTools fail-before-spend (its host truth comes
  // from the resolver environment, not an ad-hoc isTauri probe here).
  const { isAgentExecutionFlagEnabled } = await import("@/lib/ai/agent/execution/feature-flags")
  const resolverAuthoritative = isAgentExecutionFlagEnabled("agentExecutionResolverV2")

  // requireTools is a hard precondition — check BEFORE spending a turn.
  // (Flag off only; the service enforces the same policy fail-closed.)
  if (!resolverAuthoritative && toolsEnabled && params.requireTools) {
    const { isTauri } = await import("@/lib/tauri")
    if (!isTauri()) {
      throw nonRetryable(REQUIRE_TOOLS_UNAVAILABLE_MESSAGE)
    }
  }

  const { startSpan, endSpan } = await import("@cognia/agent-trace/emitter")
  const span = startSpan({
    operationName: "invoke_agent",
    providerName: "cognia.workflow",
    surface: "workflow",
    sessionId: ctx.runId,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(params.model ? { requestModel: params.model } : {}),
  })

  try {
    const [{ executeAgent }, { getSettings }] = await Promise.all([
      import("@/lib/ai/agent/agent-executor"),
      import("@/lib/db/settings"),
    ])
    // Provider snapshot for the text channel (the sidecar channel resolves
    // its own provider through resolveSendOptions).
    const settings = await getSettings().catch(() => undefined)

    // Single turn runner: the unified service behind the flag (surface +
    // requireTools become resolver policy; the host-unavailable failure keeps
    // the node's pinned error copy), the legacy executor otherwise.
    const runTurn = async (
      turnPrompt: string,
      cfg: Parameters<typeof executeAgent>[1]
    ): Promise<ExecuteAgentResult & { degradedReason?: string }> => {
      if (!resolverAuthoritative) return executeAgent(turnPrompt, cfg)
      const [{ executeAgentTurn, AgentHostUnavailableError }, { isTauri }] = await Promise.all([
        import("@/lib/ai/agent/execution/agent-execution-service"),
        import("@/lib/tauri"),
      ])
      try {
        return await executeAgentTurn(
          turnPrompt,
          cfg ?? {},
          { isTauri: isTauri(), isHeadlessHost: false },
          {
            surface: "workflow-agent-turn",
            ...(params.requireTools !== undefined ? { requireTools: params.requireTools } : {}),
            identity: { sessionId: ctx.runId, runId: ctx.runId },
          }
        )
      } catch (err) {
        if (err instanceof AgentHostUnavailableError) {
          throw nonRetryable(REQUIRE_TOOLS_UNAVAILABLE_MESSAGE)
        }
        throw err
      }
    }

    const baseOptions = {
      systemPrompt: params.systemPrompt,
      model: params.model,
      maxSteps: params.maxTurns,
      temperature: params.temperature,
      abortSignal: ctx.signal,
      toolsEnabled,
      characterId: params.characterId,
      cwd: params.cwd,
      allowedTools: params.allowedTools,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onDelta: ctx.emitStream,
      ...(settings
        ? {
            defaultProvider: settings.defaultProvider,
            providerSettings: settings.providerSettings as NonNullable<
              Parameters<typeof executeAgent>[1]
            >["providerSettings"],
            customProviders: settings.customProviders as NonNullable<
              Parameters<typeof executeAgent>[1]
            >["customProviders"],
          }
        : {}),
    }

    // Typed-output path (D3): parse + validate + one bounded auto-fix retry.
    // Usage is accumulated across every model call (the retry counts).
    const outputSchema = params.outputSchema
    let result: ExecuteAgentResult
    let structured: { object: unknown; schemaValid: boolean; schemaErrors?: string[] } | undefined

    if (outputSchema && Object.keys(outputSchema).length > 0) {
      let last: ExecuteAgentResult | undefined
      const usageAcc = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      let sawUsage = false
      const outcome = await runStructuredTurn({
        outputSchema,
        onSchemaViolation: params.onSchemaViolation,
        runOnce: async (fix) => {
          // The corrective re-prompt rides the user message (prompt-injection
          // is the only structured-output mechanism on the sidecar channel).
          const turnPrompt = fix ? `${prompt}\n\n${fix}` : prompt
          const r = await runTurn(turnPrompt, {
            ...baseOptions,
            outputFormat: { type: "json_schema", schema: outputSchema },
          })
          last = r
          if (r.usage) {
            sawUsage = true
            usageAcc.inputTokens += r.usage.inputTokens
            usageAcc.outputTokens += r.usage.outputTokens
            usageAcc.totalTokens += r.usage.totalTokens
          }
          return { object: r.object, parseError: r.parseError }
        },
      })
      if (!last) throw new Error("action.agent.turn: structured turn produced no result")
      result = sawUsage ? { ...last, usage: usageAcc } : last
      structured = {
        object: outcome.object,
        schemaValid: outcome.schemaValid,
        ...(outcome.schemaErrors ? { schemaErrors: outcome.schemaErrors } : {}),
      }
    } else {
      result = await runTurn(prompt, baseOptions)
    }

    const degradedReason = (result as { degradedReason?: string }).degradedReason
    if (toolsEnabled && !result.toolsAvailable) {
      ctx.log(
        "warn",
        "action.agent.turn: tools were requested but the sidecar is unavailable — " +
          "ran as a text-only completion (no tool calls were possible)." +
          (degradedReason ? ` [degradedReason: ${degradedReason}]` : "")
      )
    }

    if (result.usage) {
      ctx.reportUsage?.({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        ...(params.model ? { modelId: params.model } : {}),
      })
    }

    endSpan(span.spanId, {
      ...(result.usage
        ? {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }
        : {}),
      ...(params.model ? { responseModel: params.model } : {}),
      outputPreview: result.text.slice(0, 200),
    })

    return {
      output: {
        text: result.text,
        channel: result.channel,
        toolsAvailable: result.toolsAvailable,
        ...(degradedReason ? { degradedReason } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(structured
          ? {
              object: structured.object,
              schemaValid: structured.schemaValid,
              ...(structured.schemaErrors ? { schemaErrors: structured.schemaErrors } : {}),
            }
          : {}),
      },
    }
  } catch (err) {
    endSpan(span.spanId, {
      errorType: err instanceof Error ? err.name : "Error",
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
