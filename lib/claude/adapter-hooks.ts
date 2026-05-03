/**
 * Thin wrappers around the plugin lifecycle hook dispatcher so the SDK
 * message pump and request build site can fan out events without learning
 * the full hook system shape. Every wrapper is a no-op when the dispatcher
 * has no registered listeners — keeps the hot path cheap when no plugins
 * are wired up.
 */

import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import type { PluginMessage } from "@/types/plugin"

interface DispatcherInternals {
  hooks?: { has: (name: string) => boolean }
  dispatcher?: { hooks?: { has: (name: string) => boolean } }
}

function hasListeners(hookName: string): boolean {
  const dispatcher = getPluginLifecycleHooks() as unknown as DispatcherInternals
  // The dispatcher caches a Map<hookName, Set<plugin>> — we read it through
  // the cast above but degrade gracefully if the internal shape changes.
  const hooks = dispatcher.dispatcher?.hooks ?? dispatcher.hooks
  if (hooks && typeof hooks.has === "function") {
    return hooks.has(hookName)
  }
  return true // when in doubt, dispatch — keep the wrapper safe.
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
  if (!hasListeners("onUserPromptSubmit")) {
    return { action: "proceed" }
  }
  try {
    return (await getPluginLifecycleHooks().dispatchUserPromptSubmit(
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
  if (!hasListeners("onPreToolUse")) return { action: "allow" }
  try {
    return (await getPluginLifecycleHooks().dispatchPreToolUse(
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
  if (!hasListeners("onPostToolUse")) return {}
  try {
    return (await getPluginLifecycleHooks().dispatchPostToolUse(
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

/** Fired when an SDK stream begins. */
export function dispatchStreamStart(sessionId: string): void {
  if (!hasListeners("onStreamStart")) return
  try {
    getPluginLifecycleHooks().dispatchStreamStart(sessionId)
  } catch {
    // hooks must not break the stream
  }
}

/** Fired for every chunk in an SDK stream. */
export function dispatchStreamChunk(sessionId: string, chunk: string, fullContent: string): void {
  if (!hasListeners("onStreamChunk")) return
  try {
    getPluginLifecycleHooks().dispatchStreamChunk(sessionId, chunk, fullContent)
  } catch {
    // ignore
  }
}

/** Fired when an SDK stream completes. */
export function dispatchStreamEnd(sessionId: string, finalContent: string): void {
  if (!hasListeners("onStreamEnd")) return
  try {
    getPluginLifecycleHooks().dispatchStreamEnd(sessionId, finalContent)
  } catch {
    // ignore
  }
}

/** Fired when the SDK reports a chat-level error. */
export function dispatchChatError(sessionId: string, error: Error): void {
  if (!hasListeners("onChatError")) return
  try {
    getPluginLifecycleHooks().dispatchChatError(sessionId, error)
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
  if (!hasListeners("onTokenUsage")) return
  try {
    getPluginLifecycleHooks().dispatchTokenUsage(sessionId, usage)
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
  if (!hasListeners("onPostChatReceive")) return {}
  try {
    return await getPluginLifecycleHooks().dispatchPostChatReceive(response as never)
  } catch {
    return {}
  }
}

// Re-export the no-listeners predicate so unit tests can verify the
// short-circuit path without poking the singleton internals.
export { hasListeners as __hasListenersForTests }
