/**
 * Routes a parsed `@<name>` mention from the team workspace chat to the
 * appropriate runtime adapter and writes its streaming output back to the
 * agent-team store as a regular `AgentTeamMessage`.
 *
 * The dispatcher is **decoupled from React** — every external dependency
 * (the Anthropic streamer, the external-agent streamer, the store writer)
 * is injected so unit tests can mock them with plain async generators.
 *
 * Flow per dispatch:
 *   1. Persist a user-authored `AgentTeamMessage` (`senderId = TEAM_USER_SENDER_ID`).
 *   2. Persist an empty placeholder agent message with `metadata.streaming = true`.
 *   3. Iterate the runtime stream, accumulate text, and `upsertMessage` the
 *      placeholder so the UI re-renders incrementally. Tool events are
 *      mirrored into `metadata.toolCalls` so the UI can render cards.
 *   4. On done: clear the streaming flag and persist `tokenUsage`.
 *   5. On error: replace content with an error indicator and clear the flag.
 *
 * The function never throws — every failure surfaces as an error message
 * card so the demo path stays deterministic.
 */

import { nanoid } from "nanoid"
import type { AgentTeamMessage, TeammateRuntime } from "@/types/agent/agent-team"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import type { MentionTarget } from "./runtime-targets"
import type { ConversationTurn } from "./conversation-context"

// ---------------------------------------------------------------------------
// Stream event shape the dispatcher consumes from any runtime adapter.
// ---------------------------------------------------------------------------

export type RuntimeStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_start"; id: string; name: string; input?: string }
  | { kind: "tool_result"; id: string; output: string; isError?: boolean }
  | { kind: "error"; message: string }
  | { kind: "done"; tokenUsage?: SubAgentTokenUsage }

/** Persisted snapshot of a single tool call (mirrors metadata.toolCalls entries). */
export interface ToolCallEntry {
  id: string
  name: string
  input?: string
  output?: string
  status: "running" | "complete" | "error"
}

// ---------------------------------------------------------------------------
// Injected dependencies.
// ---------------------------------------------------------------------------

export interface TeamMessageWriter {
  upsertMessage: (message: AgentTeamMessage) => void
}

/**
 * Open a stream against the requested runtime. The implementation lives at
 * the React layer (it owns `useExternalAgent` + the AI-SDK Anthropic client);
 * the dispatcher only consumes the resulting iterable.
 */
export interface RuntimeStreamer {
  stream: (params: {
    runtime: TeammateRuntime
    prompt: string
    target: MentionTarget
    signal: AbortSignal
    history?: readonly ConversationTurn[]
  }) => AsyncIterable<RuntimeStreamEvent>
}

export interface DispatchTeamMentionParams {
  teamId: string
  target: MentionTarget
  /** Body of the message *after* the leading `@<name>` token has been stripped. */
  prompt: string
  /** The full original text typed by the user — written verbatim to the user message. */
  rawText: string
  /** Optional display name for the human user (defaults to "You"). */
  userDisplayName?: string
  /** Optional cancellation signal threaded into the runtime stream. */
  signal?: AbortSignal
  /** Prior conversation context — surfaces multi-turn history to the runtime. */
  history?: readonly ConversationTurn[]
}

export interface DispatchTeamMentionResult {
  /** The id of the user's message persisted to the store. */
  userMessageId: string
  /** The id of the agent's placeholder/final message. */
  agentMessageId: string
  /** True when the runtime returned at least one text chunk and finished cleanly. */
  ok: boolean
  /** Final concatenated content (without the streaming placeholder). */
  finalText: string
  /** Token usage if the runtime reported it. */
  tokenUsage?: SubAgentTokenUsage
  /** Error message when the runtime failed (also reflected in the agent message). */
  error?: string
  /** Tool call snapshots mirrored into the message metadata. */
  toolCalls?: ToolCallEntry[]
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const STREAMING_METADATA_KEY = "streaming"
const ERROR_METADATA_KEY = "errored"
const RUNTIME_METADATA_KEY = "runtime"
const TOOL_CALLS_METADATA_KEY = "toolCalls"
const TOKEN_USAGE_METADATA_KEY = "tokenUsage"
const DISPATCH_TARGET_ID_KEY = "dispatchTargetId"
const DISPATCH_PROMPT_KEY = "dispatchPrompt"

/**
 * Dispatch a mention to its runtime and stream the result back into the
 * team's message list. See module-level doc for the full lifecycle.
 */
export async function dispatchTeamMention(
  params: DispatchTeamMentionParams,
  deps: { writer: TeamMessageWriter; streamer: RuntimeStreamer }
): Promise<DispatchTeamMentionResult> {
  const { teamId, target, prompt, rawText, userDisplayName = "You", signal, history } = params
  const { writer, streamer } = deps
  const now = () => new Date()

  const userMessageId = nanoid()
  const agentMessageId = nanoid()

  const userMessage: AgentTeamMessage = {
    id: userMessageId,
    teamId,
    type: "direct",
    senderId: TEAM_USER_SENDER_ID,
    senderName: userDisplayName,
    recipientId: target.id,
    recipientName: target.name,
    content: rawText,
    read: true,
    timestamp: now(),
    metadata: {
      [RUNTIME_METADATA_KEY]: target.runtime,
      fromUser: true,
    },
  }
  writer.upsertMessage(userMessage)

  const placeholder: AgentTeamMessage = {
    id: agentMessageId,
    teamId,
    type: "direct",
    senderId: target.id,
    senderName: target.name,
    recipientId: TEAM_USER_SENDER_ID,
    recipientName: userDisplayName,
    content: "",
    read: false,
    timestamp: now(),
    metadata: {
      [RUNTIME_METADATA_KEY]: target.runtime,
      [STREAMING_METADATA_KEY]: true,
      [DISPATCH_TARGET_ID_KEY]: target.id,
      [DISPATCH_PROMPT_KEY]: prompt,
    },
  }
  writer.upsertMessage(placeholder)

  const ac = new AbortController()
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason)
    else signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true })
  }

  let acc = ""
  let tokenUsage: SubAgentTokenUsage | undefined
  let error: string | undefined
  const toolCallMap = new Map<string, ToolCallEntry>()

  const writeProgress = () => {
    writer.upsertMessage({
      ...placeholder,
      content: acc,
      metadata: {
        [RUNTIME_METADATA_KEY]: target.runtime,
        [STREAMING_METADATA_KEY]: true,
        [DISPATCH_TARGET_ID_KEY]: target.id,
        [DISPATCH_PROMPT_KEY]: prompt,
        [TOOL_CALLS_METADATA_KEY]: Array.from(toolCallMap.values()),
      },
    })
  }

  try {
    const iterator = streamer.stream({
      runtime: target.runtime,
      prompt,
      target,
      signal: ac.signal,
      history,
    })
    for await (const event of iterator) {
      if (ac.signal.aborted) {
        error = "aborted"
        break
      }
      switch (event.kind) {
        case "text":
          if (event.delta) {
            acc += event.delta
            writeProgress()
          }
          break
        case "tool_start": {
          toolCallMap.set(event.id, {
            id: event.id,
            name: event.name,
            input: event.input,
            status: "running",
          })
          writeProgress()
          break
        }
        case "tool_result": {
          const existing = toolCallMap.get(event.id)
          toolCallMap.set(event.id, {
            id: event.id,
            name: existing?.name ?? "tool",
            input: existing?.input,
            output: event.output,
            status: event.isError ? "error" : "complete",
          })
          writeProgress()
          break
        }
        case "error":
          error = event.message || "Runtime returned an error event"
          break
        case "done":
          tokenUsage = event.tokenUsage ?? tokenUsage
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  // If the external signal fired while streaming, surface that as an abort
  // even when the streamer completed cleanly afterwards.
  if (!error && ac.signal.aborted) {
    error = "aborted"
  }

  const toolCalls = Array.from(toolCallMap.values())

  // Final write — drop the streaming flag, mark error if any.
  if (error) {
    const errText = formatErrorMessage(error, acc)
    writer.upsertMessage({
      ...placeholder,
      content: errText,
      timestamp: now(),
      metadata: {
        [RUNTIME_METADATA_KEY]: target.runtime,
        [ERROR_METADATA_KEY]: true,
        [DISPATCH_TARGET_ID_KEY]: target.id,
        [DISPATCH_PROMPT_KEY]: prompt,
        [TOOL_CALLS_METADATA_KEY]: toolCalls.length > 0 ? toolCalls : undefined,
      },
    })
    return {
      userMessageId,
      agentMessageId,
      ok: false,
      finalText: errText,
      error,
      tokenUsage,
      toolCalls,
    }
  }

  writer.upsertMessage({
    ...placeholder,
    content: acc,
    timestamp: now(),
    metadata: {
      [RUNTIME_METADATA_KEY]: target.runtime,
      [DISPATCH_TARGET_ID_KEY]: target.id,
      [DISPATCH_PROMPT_KEY]: prompt,
      [TOKEN_USAGE_METADATA_KEY]: tokenUsage as Record<string, unknown> | undefined,
      [TOOL_CALLS_METADATA_KEY]: toolCalls.length > 0 ? toolCalls : undefined,
    },
  })
  return { userMessageId, agentMessageId, ok: true, finalText: acc, tokenUsage, toolCalls }
}

function formatErrorMessage(error: string, partial: string): string {
  const head = partial ? `${partial}\n\n` : ""
  return `${head}❌ ${error}`
}

// Re-exported metadata keys for the renderer to introspect.
export const TEAM_MESSAGE_METADATA_KEYS = {
  STREAMING: STREAMING_METADATA_KEY,
  ERROR: ERROR_METADATA_KEY,
  RUNTIME: RUNTIME_METADATA_KEY,
  TOOL_CALLS: TOOL_CALLS_METADATA_KEY,
  TOKEN_USAGE: TOKEN_USAGE_METADATA_KEY,
  DISPATCH_TARGET_ID: DISPATCH_TARGET_ID_KEY,
  DISPATCH_PROMPT: DISPATCH_PROMPT_KEY,
} as const
