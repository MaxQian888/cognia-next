/**
 * Plugin Agent SDK — per-run tracing (Package F).
 *
 * Thin wrapper over the agent-trace emitter (`lib/agent-trace/emitter.ts`):
 * wraps a run in a `plugin-hook` span so plugin agent activity shows up in the
 * tracing dashboard alongside chat / team / workflow spans. Channel-agnostic
 * and fully optional (engaged only when `trace` is requested). Never throws on
 * its own — a tracing failure must not break the run.
 */

import type { ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"

export interface RunTraceMeta {
  pluginId?: string
  /** Cancellation/trace handle for the run (used as the span's sessionId). */
  agentId: string
  model?: string
}

/**
 * Run `fn` inside a trace span when `enabled`. Records usage + finish + errors.
 * Passes the run through untouched when disabled or when the emitter is absent.
 */
export async function withRunTrace(
  enabled: boolean,
  meta: RunTraceMeta,
  prompt: string,
  fn: () => Promise<ExecuteAgentResult>
): Promise<ExecuteAgentResult> {
  if (!enabled) return fn()

  let emitter: typeof import("@/lib/agent-trace/emitter") | null = null
  let spanId: string | null = null
  try {
    emitter = await import("@/lib/agent-trace/emitter")
    const handle = emitter.startSpan({
      operationName: "invoke_agent",
      providerName: "cognia.plugin",
      surface: "plugin-hook",
      sessionId: meta.agentId,
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.model ? { requestModel: meta.model } : {}),
      inputPreview: prompt.slice(0, 200),
    })
    spanId = handle.spanId
  } catch {
    // Tracing unavailable — run untraced.
    return fn()
  }

  try {
    const result = await fn()
    try {
      emitter.endSpan(spanId, {
        ...(result.usage
          ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
            }
          : {}),
        ...(result.finishReason ? { finishReasons: [result.finishReason] } : {}),
        outputPreview: result.text.slice(0, 200),
        metadata: { channel: result.channel, toolsAvailable: result.toolsAvailable },
      })
    } catch {
      /* end-span failure must not mask the result */
    }
    return result
  } catch (err) {
    try {
      emitter.endSpan(spanId, {
        errorType: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    } catch {
      /* swallow */
    }
    throw err
  }
}
