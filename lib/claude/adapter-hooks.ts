/**
 * Thin wrappers around the plugin hook dispatchers so the SDK message
 * pump and request build site can fan out events without learning the
 * full hook system shape. Every wrapper is a no-op when the relevant
 * dispatcher has no registered listeners — keeps the hot path cheap
 * when no plugins are wired up.
 *
 * The `lib/plugin/messaging/hooks-system` module exposes two distinct
 * singletons:
 *
 * - `PluginLifecycleHooks` — `onLoad/onEnable/onDisable`, scheduled
 *   tasks, message pipeline (`onMessageSend/Receive`), session, command,
 *   chat flow, plan, agent, A2UI.
 * - `PluginEventHooks` — `onUserPromptSubmit/onPreToolUse/onPostToolUse`,
 *   `onStreamStart/Chunk/End`, `onChatError`, `onTokenUsage`,
 *   `onPostChatReceive`.
 *
 * Each method below routes to the dispatcher that owns the matching hook.
 */

import { getPluginEventHooks, getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import type { PluginHooks, PluginMessage } from "@/types/plugin"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"

function hasListeners(hookName: keyof PluginHooks): boolean {
  // Lifecycle-scoped query against the real singleton — true only when some
  // plugin actually registered this hook, so the dispatch is genuinely skipped
  // when nothing is wired.
  return getPluginLifecycleHooks().hasAnyHook(hookName)
}

function hasEventListeners(hookName: keyof PluginHooksAll): boolean {
  // Event-scoped query (separate singleton from lifecycle hooks).
  return getPluginEventHooks().hasAnyHook(hookName)
}

/**
 * Whether any plugin registered `onPostToolUse`. The chat send path uses this
 * to decide if the sidecar's `tool_result_review` round-trip is worth paying
 * for the turn (`sendOptions.toolResultReviewEnabled`).
 */
export function hasPostToolUseListeners(): boolean {
  return hasEventListeners("onPostToolUse")
}

export interface PromptSubmitContextLike {
  characterId?: string
  modelHint?: string
  attachmentsCount?: number
  metadata?: Record<string, unknown>
}

export interface PromptSubmitResultLike {
  action: "proceed" | "modify" | "block"
  modifiedPrompt?: string
  reason?: string
}

/** Fired when a user message is about to be sent to Claude. */
export async function dispatchUserPromptSubmit(
  prompt: string,
  sessionId: string,
  context: PromptSubmitContextLike = {}
): Promise<PromptSubmitResultLike> {
  if (!hasEventListeners("onUserPromptSubmit")) {
    return { action: "proceed" }
  }
  try {
    return (await getPluginEventHooks().dispatchUserPromptSubmit(
      prompt,
      sessionId,
      context as never
    )) as PromptSubmitResultLike
  } catch {
    return { action: "proceed" }
  }
}

export interface PreToolUseResultLike {
  action: "allow" | "deny" | "modify"
  modifiedArgs?: Record<string, unknown>
  reason?: string
}

/** Fired before a tool call is executed by the SDK. */
export async function dispatchPreToolUse(
  toolName: string,
  toolArgs: unknown,
  sessionId: string
): Promise<PreToolUseResultLike> {
  if (!hasEventListeners("onPreToolUse")) return { action: "allow" }
  try {
    return (await getPluginEventHooks().dispatchPreToolUse(
      toolName,
      toolArgs,
      sessionId
    )) as PreToolUseResultLike
  } catch {
    return { action: "allow" }
  }
}

export interface PostToolUseResultLike {
  modifiedResult?: unknown
  additionalMessages?: PluginMessage[]
}

/** Fired after a tool returns a result. */
export async function dispatchPostToolUse(
  toolName: string,
  toolArgs: unknown,
  toolResult: unknown,
  sessionId: string
): Promise<PostToolUseResultLike> {
  if (!hasEventListeners("onPostToolUse")) return {}
  try {
    return (await getPluginEventHooks().dispatchPostToolUse(
      toolName,
      toolArgs,
      toolResult,
      sessionId
    )) as PostToolUseResultLike
  } catch {
    return {}
  }
}

/** Fired when an assistant message is received from the SDK. */
export async function dispatchOnAssistantMessage(message: PluginMessage): Promise<PluginMessage> {
  if (!hasListeners("onMessageReceive")) return message
  try {
    return await getPluginLifecycleHooks().dispatchOnMessageReceive(message)
  } catch {
    return message
  }
}

/**
 * Fired when a user message is about to be dispatched to the SDK. Pipeline
 * semantics: each plugin's `onMessageSend` may return a rewritten message;
 * the final message is what actually leaves. Fail-open on dispatcher errors.
 */
export async function dispatchOnMessageSend(message: PluginMessage): Promise<PluginMessage> {
  if (!hasListeners("onMessageSend")) return message
  try {
    return await getPluginLifecycleHooks().dispatchOnMessageSend(message)
  } catch {
    return message
  }
}

/** Fired when an SDK stream begins. */
export function dispatchStreamStart(sessionId: string): void {
  if (!hasEventListeners("onStreamStart")) return
  try {
    getPluginEventHooks().dispatchStreamStart(sessionId)
  } catch {
    // hooks must not break the stream
  }
}

/** Fired for every chunk in an SDK stream. */
export function dispatchStreamChunk(sessionId: string, chunk: string, fullContent: string): void {
  if (!hasEventListeners("onStreamChunk")) return
  try {
    getPluginEventHooks().dispatchStreamChunk(sessionId, chunk, fullContent)
  } catch {
    // ignore
  }
}

/** Fired when an SDK stream completes. */
export function dispatchStreamEnd(sessionId: string, finalContent: string): void {
  if (!hasEventListeners("onStreamEnd")) return
  try {
    getPluginEventHooks().dispatchStreamEnd(sessionId, finalContent)
  } catch {
    // ignore
  }
}

/** Fired when the SDK reports a chat-level error. */
export function dispatchChatError(sessionId: string, error: Error): void {
  // Plugin bus: the agent run failed. Emitted unconditionally (the bus has its
  // own subscriber check) — distinct from the `onChatError` hook fan-out below.
  // PII red-line: the bus reaches any `events:subscribe` plugin, so we publish
  // only the bounded error CLASS (`error.name`), never `error.message` (which
  // can echo prompt/tool text). The full message still reaches plugins via the
  // in-process `onChatError` hook below.
  emitSystemBusEvent(SystemEvents.AGENT_ERROR, { sessionId, error: error.name })
  if (!hasEventListeners("onChatError")) return
  try {
    getPluginEventHooks().dispatchChatError(sessionId, error)
  } catch {
    // ignore
  }
}

/** Fired when the SDK reports token usage. */
export function dispatchTokenUsage(
  sessionId: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
  }
): void {
  if (!hasEventListeners("onTokenUsage")) return
  try {
    // The dispatcher contract uses {prompt, completion, total}; map from
    // the SDK's {inputTokens, outputTokens} shape and ignore cache split
    // — plugins receive a normalized total either way.
    getPluginEventHooks().dispatchTokenUsage(sessionId, {
      prompt: usage.inputTokens,
      completion: usage.outputTokens,
      total: usage.inputTokens + usage.outputTokens,
    })
  } catch {
    // ignore
  }
}

export interface ChatResponseDataLike {
  sessionId: string
  message: PluginMessage
  metadata?: Record<string, unknown>
}

/** Fired after the chat reply has been received and persisted. */
export async function dispatchPostChatReceive(response: ChatResponseDataLike): Promise<unknown> {
  if (!hasEventListeners("onPostChatReceive")) return {}
  try {
    return await getPluginEventHooks().dispatchPostChatReceive(response as never)
  } catch {
    return {}
  }
}

// Re-export the no-listeners predicates so unit tests can verify the
// short-circuit paths without poking the singleton internals.
export { hasListeners as __hasListenersForTests }
export { hasEventListeners as __hasEventListenersForTests }
