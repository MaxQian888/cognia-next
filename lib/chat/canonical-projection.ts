/**
 * Project the desktop chat SDK stream onto the ADR-0090 canonical event log.
 *
 * Until now `appendCanonicalEnvelopes` had exactly two callers — the connector
 * runtime and the fleet history sink — so an ordinary desktop chat turn
 * produced **no durable event log at all**. Spans recorded that a turn happened
 * and `messages` recorded what it said, but nothing recorded what it *did* in a
 * form that could be replayed, audited, or joined to a cost row.
 *
 * This module is the pure half: SDK message in, canonical events out. The
 * stateful half (sequencing, redaction, batching, the Dexie append) lives in
 * `lib/chat/canonical-sink.ts`.
 *
 * ## What is persisted
 *
 * Semantic events are RESIDENT — they are the record, and they are small and
 * bounded per turn. Streaming deltas are not: a single long turn emits tens of
 * thousands of them, they reconstruct nothing that `messages` does not already
 * hold verbatim, and persisting them by default would trade the entire benefit
 * of the log for IndexedDB pressure. They are emitted only while a trace debug
 * session has armed the `deltas` tier (`lib/observability/debug-session.ts`).
 *
 * Tool payloads and prompt text follow the same rule under their own tiers.
 * With nothing armed the log records *that* a tool ran, with what name and call
 * id, and whether it failed — never the arguments or the output.
 */

import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"
import type { SDKMessage } from "@cognia/agent-config-types"

import { normalizeUsageBlock, type RawProviderUsage } from "@/lib/ai/chat/usage-normalize"

/**
 * Which optional content the caller has armed. All-false is the default and the
 * only state a normal install ever runs in.
 */
export interface ChatCanonicalCaptureTiers {
  /** Persist `text-delta` / `thinking-delta` / `content-part` frames. */
  deltas: boolean
  /** Persist the user's prompt text on `user-input`. */
  prompts: boolean
  /** Persist tool call arguments and tool result bodies. */
  toolDetails: boolean
}

export const NO_CAPTURE: ChatCanonicalCaptureTiers = {
  deltas: false,
  prompts: false,
  toolDetails: false,
}

/**
 * Kinds persisted on every turn regardless of any debug session.
 *
 * This is the plan's resident set. It is deliberately the *semantic* surface:
 * everything a reader needs to answer "what did this run do, and did it work?".
 */
export const RESIDENT_CHAT_EVENT_KINDS: ReadonlySet<CanonicalAgentEvent["kind"]> = new Set([
  "lifecycle",
  "tool-call",
  "tool-result",
  "permission-request",
  "permission-resolved",
  "usage",
  "compact",
  "checkpoint",
  "subagent",
  "retry",
  "failure",
  "warning",
  "model-request",
  "model-refusal",
  "session-init",
])

/**
 * Kinds dropped unless the `deltas` tier is armed. Everything they carry is
 * either reconstructable from `messages` or pure streaming noise.
 */
export const DELTA_CHAT_EVENT_KINDS: ReadonlySet<CanonicalAgentEvent["kind"]> = new Set([
  "text-delta",
  "thinking-delta",
  "commentary-delta",
  "content-part",
  "tool-progress",
])

/**
 * Kinds dropped unless the `prompts` tier is armed.
 *
 * The user's prompt is already stored verbatim in `messages`; writing it into
 * the event log too would duplicate the most sensitive text in the app into a
 * second table for no reconstruction benefit. `lifecycle: started` is what
 * marks the turn boundary on an ordinary run.
 */
export const PROMPT_CHAT_EVENT_KINDS: ReadonlySet<CanonicalAgentEvent["kind"]> = new Set([
  "user-input",
])

/** True when `kind` is persisted on an ordinary turn. */
export function isResidentChatEventKind(kind: CanonicalAgentEvent["kind"]): boolean {
  return RESIDENT_CHAT_EVENT_KINDS.has(kind)
}

/**
 * Filter a batch against the armed tiers.
 *
 * A kind that is neither resident nor explicitly gated (a diagnostic, a
 * rate-limit notice, a runtime-specific frame) is KEPT: the resident set names
 * what we are sure is worth storing, and silently dropping an unrecognised
 * semantic event is how a log stops being trustworthy. Only the high-volume
 * delta kinds and the duplicated prompt are gated.
 */
export function filterChatCanonicalEvents(
  events: readonly CanonicalAgentEvent[],
  tiers: ChatCanonicalCaptureTiers
): CanonicalAgentEvent[] {
  return events.filter((event) => {
    if (DELTA_CHAT_EVENT_KINDS.has(event.kind)) return tiers.deltas
    if (PROMPT_CHAT_EVENT_KINDS.has(event.kind)) return tiers.prompts
    return true
  })
}

interface ContentBlockLike {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  text?: unknown
  thinking?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

function blocksOf(message: SDKMessage): ContentBlockLike[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ContentBlockLike => !!block && typeof block === "object")
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Collapse a tool result body to a size/shape summary.
 *
 * The point is that a reader can still tell a 4-byte result from a 400 KB one
 * without the log holding either. Claude Code's own `tool_result` event carries
 * exactly this (`tool_result_size_bytes`), for the same reason.
 */
function summarizeToolResult(content: unknown): Record<string, unknown> {
  if (content === undefined || content === null) return { omitted: true }
  let bytes = 0
  try {
    bytes = typeof content === "string" ? content.length : JSON.stringify(content).length
  } catch {
    // Circular / unserializable payload — the size is unknowable, say so.
    return { omitted: true, unserializable: true }
  }
  return { omitted: true, sizeBytes: bytes }
}

/**
 * Narrow one SDK message into canonical events.
 *
 * Returns `[]` for frames that carry nothing durable. Never throws: a
 * malformed frame produces no events rather than breaking the turn.
 */
export function canonicalEventsFromSdkMessage(
  message: SDKMessage,
  tiers: ChatCanonicalCaptureTiers = NO_CAPTURE
): CanonicalAgentEvent[] {
  if (!message || typeof message !== "object") return []
  const out: CanonicalAgentEvent[] = []

  switch (message.type) {
    case "assistant": {
      for (const block of blocksOf(message)) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          out.push({
            kind: "tool-call",
            toolName: block.name,
            // Arguments are the single largest and most sensitive thing a tool
            // call carries — a `Write` call holds the whole file.
            input: tiers.toolDetails ? toRecord(block.input) : {},
            ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
          })
        } else if (tiers.deltas && block.type === "text" && typeof block.text === "string") {
          out.push({ kind: "text-delta", delta: block.text })
        } else if (
          tiers.deltas &&
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          out.push({ kind: "thinking-delta", delta: block.thinking })
        }
      }
      return out
    }

    case "user": {
      for (const block of blocksOf(message)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
        out.push({
          kind: "tool-result",
          // The SDK's result block does not repeat the tool name; the sink
          // resolves it from the call it already recorded.
          toolName: "unknown",
          toolCallId: block.tool_use_id,
          result: tiers.toolDetails ? block.content : summarizeToolResult(block.content),
          ...(block.is_error === true ? { isError: true } : {}),
        })
      }
      return out
    }

    case "result": {
      const result = message as unknown as {
        subtype?: string
        is_error?: boolean
        usage?: RawProviderUsage
        total_cost_usd?: number
        duration_ms?: number
      }
      if (result.usage) {
        const usage = normalizeUsageBlock(result.usage)
        out.push({
          kind: "usage",
          usage: {
            ...(usage as unknown as Record<string, unknown>),
            // Same snake_case convention as the normalized block it rides on,
            // and the same key the SDK itself uses.
            ...(typeof result.total_cost_usd === "number"
              ? { total_cost_usd: result.total_cost_usd }
              : {}),
          },
        })
      }
      if (result.is_error === true) {
        out.push({
          kind: "failure",
          code: result.subtype ? `chat_${result.subtype}` : "chat_error",
          message: result.subtype ?? "chat turn failed",
        })
      }
      return out
    }

    case "stream_event": {
      if (!tiers.deltas) return out
      const event = (message as { event?: { type?: string; delta?: Record<string, unknown> } })
        .event
      const delta = event?.delta
      if (event?.type !== "content_block_delta" || !delta) return out
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        out.push({ kind: "text-delta", delta: delta.text })
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        out.push({ kind: "thinking-delta", delta: delta.thinking })
      }
      return out
    }

    case "system":
      return systemEvents(message, tiers)

    default:
      return out
  }
}

function systemEvents(
  message: SDKMessage,
  tiers: ChatCanonicalCaptureTiers
): CanonicalAgentEvent[] {
  const system = message as unknown as Record<string, unknown>
  const subtype = typeof system.subtype === "string" ? system.subtype : ""

  switch (subtype) {
    case "init": {
      const mcp = Array.isArray(system.mcp_servers)
        ? (system.mcp_servers as Array<Record<string, unknown>>)
            .map((server) => ({
              name: String(server?.name ?? ""),
              status: String(server?.status ?? "unknown"),
            }))
            .filter((server) => server.name.length > 0)
        : undefined
      return [
        {
          kind: "session-init",
          ...(typeof system.model === "string" ? { model: system.model } : {}),
          ...(typeof system.cwd === "string" ? { cwd: system.cwd } : {}),
          // Tool NAMES are configuration, not content — they are what makes the
          // preamble worth keeping ("which tools did this run actually have?").
          ...(Array.isArray(system.tools)
            ? { tools: (system.tools as unknown[]).map(String) }
            : {}),
          ...(mcp && mcp.length > 0 ? { mcpServers: mcp } : {}),
          ...(typeof system.permissionMode === "string"
            ? { permissionMode: system.permissionMode }
            : typeof system.permission_mode === "string"
              ? { permissionMode: system.permission_mode }
              : {}),
        },
      ]
    }

    case "compact_boundary": {
      const metadata = toRecord(system.compact_metadata)
      const trigger = metadata.trigger === "manual" ? "manual" : "auto"
      return [
        {
          kind: "compact",
          trigger,
          ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
          ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {}),
        },
      ]
    }

    case "task_started":
      return [
        {
          kind: "subagent",
          phase: "started",
          ...(typeof system.subagent_type === "string"
            ? { runtimeBinding: system.subagent_type }
            : typeof system.description === "string" && tiers.prompts
              ? { runtimeBinding: system.description }
              : {}),
        },
      ]

    case "task_completed":
    case "task_failed":
      return [
        {
          kind: "subagent",
          phase: "ended",
          ...(typeof system.subagent_type === "string"
            ? { runtimeBinding: system.subagent_type }
            : {}),
        },
      ]

    default:
      return []
  }
}
