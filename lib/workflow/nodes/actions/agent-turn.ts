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
}

const DEFAULT_TIMEOUT_MS = 600_000

export async function runAgentTurn(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as AgentTurnParams
  const prompt = (params.prompt ?? "").trim()
  if (!prompt) {
    throw nonRetryable("action.agent.turn requires a non-empty 'prompt'")
  }
  const toolsEnabled = params.toolsEnabled !== false

  // requireTools is a hard precondition — check BEFORE spending a turn.
  if (toolsEnabled && params.requireTools) {
    const { isTauri } = await import("@/lib/tauri")
    if (!isTauri()) {
      throw nonRetryable(
        "action.agent.turn: tools required but the desktop sidecar is unavailable " +
          "(web/mobile run). Unset 'requireTools' to allow the text-only fallback."
      )
    }
  }

  const { startSpan, endSpan } = await import("@/lib/agent-trace/emitter")
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

    const result = await executeAgent(prompt, {
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
    })

    if (toolsEnabled && !result.toolsAvailable) {
      ctx.log(
        "warn",
        "action.agent.turn: tools were requested but the sidecar is unavailable — " +
          "ran as a text-only completion (no tool calls were possible)."
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
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
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
