/**
 * `action.agent.turn` — run one full agent turn as a workflow step.
 *
 * Desktop (Tauri): rides the tool-enabled sidecar pipeline (the agent rail
 * with `toolsEnabled`), so the agent can call Bash/Read/Edit/plugin/MCP
 * tools subject to the existing per-tool approval gate and the
 * character's `allowedTools`. Web/mobile: degrades to a text-only
 * completion and reports `toolsAvailable: false` honestly — set
 * `requireTools: true` to fail instead of degrading.
 */

import type {
  StepExecutionContext,
  StepExecutionResult,
  WorkflowPiiGateMode,
} from "@/types/workflow/visual"
import {
  runStructuredTurn,
  type SchemaViolationMode,
} from "@/lib/workflow/nodes/ai/structured-turn"
import type { ExecuteAgentConfig, ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"

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
  piiGate?: WorkflowPiiGateMode
}

const DEFAULT_TIMEOUT_MS = 600_000

/** Pinned copy — asserted by tests; the service path must fail with the same words. */
const REQUIRE_TOOLS_UNAVAILABLE_MESSAGE =
  "action.agent.turn: tools required but the desktop sidecar is unavailable " +
  "(web/mobile run). Unset 'requireTools' to allow the text-only fallback."

export async function runAgentTurn(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as AgentTurnParams
  const guarded = guardWorkflowEgress({
    securityContext: ctx.securityContext,
    sink: "model",
    requestedMode: params.piiGate,
    value: { prompt: params.prompt ?? "", systemPrompt: params.systemPrompt },
  })
  const prompt = guarded.value.prompt.trim()
  if (!prompt) {
    throw nonRetryable("action.agent.turn requires a non-empty 'prompt'")
  }
  const toolsEnabled = params.toolsEnabled !== false

  // ADR-0090: the unified service owns rail selection AND the requireTools
  // fail-before-spend. Its host truth comes from the resolver environment, so
  // the ad-hoc `isTauri()` precheck that used to live here is gone — it was a
  // second implementation of the same policy and could only drift.

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
    const { getSettings } = await import("@/lib/db/settings")
    // Provider snapshot for the text channel (the sidecar channel resolves
    // its own provider through resolveSendOptions).
    const settings = await getSettings().catch(() => undefined)

    // Single turn runner through the unified service: `surface` and
    // `requireTools` become resolver policy, and the host-unavailable failure
    // is remapped so the node keeps its pinned error copy.
    const runTurn = async (
      turnPrompt: string,
      cfg: ExecuteAgentConfig
    ): Promise<ExecuteAgentResult & { degradedReason?: string }> => {
      const [{ executeAgentTurn, AgentHostUnavailableError }, { isTauri }, { isHeadlessHost }] =
        await Promise.all([
          import("@/lib/ai/agent/execution/agent-execution-service"),
          import("@/lib/tauri"),
          import("@/lib/platform/detect"),
        ])
      try {
        return await executeAgentTurn(
          turnPrompt,
          cfg ?? {},
          { isTauri: isTauri(), isHeadlessHost: isHeadlessHost() },
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
      systemPrompt: guarded.value.systemPrompt,
      model: params.model,
      maxSteps: params.maxTurns,
      temperature: params.temperature,
      abortSignal: ctx.signal,
      toolsEnabled,
      characterId: params.characterId,
      cwd: params.cwd,
      allowedTools: params.allowedTools,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      permissionCeiling: ctx.securityContext?.permissionCeiling,
      onDelta: ctx.emitStream,
      onEvent: (event: CaptureStreamEvent) => {
        if (event.type === "commentary-delta" && event.delta) {
          ctx.emitCommentary?.(event.delta)
        }
      },
      ...(settings
        ? {
            defaultProvider: settings.defaultProvider,
            providerSettings:
              settings.providerSettings as NonNullable<ExecuteAgentConfig>["providerSettings"],
            customProviders:
              settings.customProviders as NonNullable<ExecuteAgentConfig>["customProviders"],
            modelMappings: settings.modelMappings,
            routingConfig: settings.routingConfig,
            autoRouting: settings.autoRouting,
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
        ...(guarded.redacted ? { piiRedacted: true } : {}),
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
