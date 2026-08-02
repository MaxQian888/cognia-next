/**
 * Concrete `RuntimeStreamer` implementations for the team workspace
 * dispatcher. Two paths:
 *
 *   - **Claude** (`runtime: "claude"` and the `@claude` virtual): goes
 *     through Vercel AI SDK's `streamText` against the user's configured
 *     Anthropic key. No Tauri sidecar dependency — the demo path runs in
 *     web mode too.
 *
 *   - **External agent** (`codex`, `claude-code`, `gemini-cli`, `cursor-cli`,
 *     and the `@codex` virtual): consumes events from
 *     `useExternalAgent().executeStreaming` and translates them into the
 *     dispatcher's `RuntimeStreamEvent` shape.
 *
 * Both implementations live behind the same factory so the React layer can
 * build one composite streamer and hand it to `dispatchTeamMention`.
 */

import { streamText, type LanguageModel } from "ai"
import { partitionPrompt } from "@/lib/ai/prompt-partition"
import type { RuntimeStreamEvent, RuntimeStreamer } from "./team-runtime-dispatcher"
import type { MentionTarget } from "./runtime-targets"
import type { TeammateRuntime } from "@/types/agent/agent-team"
import type {
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import {
  historyAsClaudeMessages,
  historyAsTextPreamble,
  type ConversationTurn,
} from "./conversation-context"

// ---------------------------------------------------------------------------
// Claude path — AI-SDK streamText
// ---------------------------------------------------------------------------

export interface ClaudeStreamerOptions {
  /** Vercel AI SDK language model — usually built via `getProviderModel`. */
  model: LanguageModel
  /** Optional system prompt — falls back to a generic team-assistant preamble. */
  systemPrompt?: string
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a teammate in a multi-agent collaboration workspace. Reply concisely and helpfully."

export async function* claudeStream(
  prompt: string,
  options: ClaudeStreamerOptions,
  signal: AbortSignal,
  history?: readonly ConversationTurn[]
): AsyncIterable<RuntimeStreamEvent> {
  const priorMessages = historyAsClaudeMessages(history ?? [])
  const messages = [...priorMessages, { role: "user" as const, content: prompt }]

  const result = streamText({
    model: options.model,
    // System content travels in the top-level instructions option — AI SDK 7
    // rejects `{ role: "system" }` inside `messages`.
    ...partitionPrompt(messages, options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
    abortSignal: signal,
  })

  try {
    for await (const chunk of result.textStream) {
      yield { kind: "text", delta: chunk }
    }
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
    try {
      usage = await result.usage
    } catch {
      usage = undefined
    }
    yield {
      kind: "done",
      tokenUsage: usage
        ? {
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          }
        : undefined,
    }
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) }
    yield { kind: "done" }
  }
}

// ---------------------------------------------------------------------------
// External-agent path — translate ExternalAgentEvent → RuntimeStreamEvent
// ---------------------------------------------------------------------------

export interface ExternalAgentStreamerHooks {
  /** Switch the global active external agent before streaming. */
  setActiveAgent: (agentId: string) => void
  /** Mirrors `useExternalAgent().executeStreaming`. */
  executeStreaming: (
    prompt: string,
    options?: ExternalAgentExecutionOptions
  ) => AsyncIterable<ExternalAgentEvent>
  /**
   * Return the configured external-agent id matching a runtime, or null when
   * the user hasn't set one up. The React layer wires this against the
   * useExternalAgentStore.
   */
  resolveAgentId: (runtime: TeammateRuntime) => string | null
}

export async function* externalAgentStream(
  prompt: string,
  runtime: TeammateRuntime,
  hooks: ExternalAgentStreamerHooks,
  history?: readonly ConversationTurn[]
): AsyncIterable<RuntimeStreamEvent> {
  const agentId = hooks.resolveAgentId(runtime)
  if (!agentId) {
    yield {
      kind: "error",
      message: `No external agent configured for "${runtime}". Open Settings → External Agents to add one.`,
    }
    yield { kind: "done" }
    return
  }
  hooks.setActiveAgent(agentId)
  const fullPrompt =
    history && history.length > 0
      ? `${historyAsTextPreamble(history)}\n[New request]\n${prompt}`
      : prompt
  try {
    for await (const event of hooks.executeStreaming(fullPrompt)) {
      const translated = translateExternalEvent(event)
      if (translated) yield translated
    }
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) }
    yield { kind: "done" }
  }
}

function serializeToolInput(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return JSON.stringify(raw)
  } catch {
    return undefined
  }
}

function translateExternalEvent(event: ExternalAgentEvent): RuntimeStreamEvent | null {
  switch (event.type) {
    case "message_delta":
      if (event.delta.type === "text" && event.delta.text) {
        return { kind: "text", delta: event.delta.text }
      }
      return null
    case "tool_use_start":
      return {
        kind: "tool_start",
        id: event.toolUseId,
        name: event.toolName,
        input: serializeToolInput(event.rawInput),
      }
    case "tool_result": {
      const output =
        typeof event.result === "string"
          ? event.result
          : (() => {
              try {
                return JSON.stringify(event.result)
              } catch {
                return `[unserializable result for ${event.toolName ?? event.toolUseId}]`
              }
            })()
      return {
        kind: "tool_result",
        id: event.toolUseId,
        output,
        isError: event.isError,
      }
    }
    case "error":
      return { kind: "error", message: event.error }
    case "done":
      return {
        kind: "done",
        tokenUsage: event.tokenUsage ? convertExternalUsage(event.tokenUsage) : undefined,
      }
    case "message_end":
      return event.tokenUsage
        ? { kind: "done", tokenUsage: convertExternalUsage(event.tokenUsage) }
        : null
    default:
      return null
  }
}

function convertExternalUsage(u: ExternalAgentTokenUsage): SubAgentTokenUsage {
  return {
    promptTokens: u.promptTokens ?? 0,
    completionTokens: u.completionTokens ?? 0,
    totalTokens: u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Composite streamer factory
// ---------------------------------------------------------------------------

export interface CompositeStreamerOptions {
  claude: ClaudeStreamerOptions
  external: ExternalAgentStreamerHooks
}

/**
 * Build a `RuntimeStreamer` that dispatches based on `MentionTarget.runtime`.
 * Used by the team workspace chat: Claude goes through AI SDK; everything
 * else goes through the external-agent infrastructure.
 */
export function createCompositeStreamer(options: CompositeStreamerOptions): RuntimeStreamer {
  return {
    stream: ({
      runtime,
      prompt,
      signal,
      history,
    }: {
      runtime: TeammateRuntime
      prompt: string
      target: MentionTarget
      signal: AbortSignal
      history?: readonly ConversationTurn[]
    }) => {
      if (runtime === "claude") {
        return claudeStream(prompt, options.claude, signal, history)
      }
      return externalAgentStream(prompt, runtime, options.external, history)
    },
  }
}
