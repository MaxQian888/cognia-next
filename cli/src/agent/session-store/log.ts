/**
 * Append-only canonical event log, and the materialization back to
 * {@link CanonicalTurn}s.
 *
 * The log is the AUTHORITY for a session's content. It is append-only: nothing
 * ever rewrites a line, which is what makes forks immutable (a fork copies a
 * prefix into a NEW log; the original is never touched) and what makes crash
 * recovery a truncation problem rather than a corruption problem.
 *
 * A line that does not parse, or that parses but is not a valid envelope, is
 * COUNTED and reported — never silently skipped. A partially-written trailing
 * line (the classic crash signature) is reported as a truncated tail so the
 * caller can say so rather than pretending the session simply ended there.
 */

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import { isAgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type {
  CanonicalTurn,
  CanonicalToolCall,
  CanonicalPermissionEvent,
  CanonicalCheckpoint,
} from "@cognia/agent-config-types/canonical-session"
import type { AgentRunUsage } from "@cognia/agent-config-types/agent-run-result"

import { eventLogPath, type SessionStoreFs } from "./paths"

export interface EventLogRead {
  envelopes: AgentEventEnvelope[]
  /** Lines that parsed as JSON but failed the envelope guard. */
  invalidLines: number
  /** Lines that were not JSON at all. */
  unparsableLines: number
  /** True when the final line had no trailing newline — an interrupted write. */
  truncatedTail: boolean
}

/** Serialize one envelope as an LF-terminated log line. */
export function encodeEnvelope(envelope: AgentEventEnvelope): string {
  return `${JSON.stringify(envelope)}\n`
}

/**
 * Append envelopes to a session's log.
 *
 * Written as ONE `appendFile` call: a single append of a byte range that ends
 * in LF is the largest unit we can make crash-atomic without a journal, so a
 * batch either lands whole or leaves a detectable truncated tail.
 */
export function appendEnvelopes(
  home: string,
  sessionId: string,
  envelopes: readonly AgentEventEnvelope[],
  fsx: SessionStoreFs,
  sessionDirOverride?: string
): void {
  if (envelopes.length === 0) return
  const target = eventLogPath(home, sessionId, sessionDirOverride)
  fsx.appendFile(target, envelopes.map(encodeEnvelope).join(""))
}

/** Read + validate a session's event log. Missing log reads as empty. */
export function readEventLog(
  home: string,
  sessionId: string,
  fsx: SessionStoreFs,
  sessionDirOverride?: string
): EventLogRead {
  const raw = fsx.readFile(eventLogPath(home, sessionId, sessionDirOverride))
  return decodeEventLog(raw)
}

/** Decode a raw log body. Exported so importers can reuse the same accounting. */
export function decodeEventLog(raw: string | null): EventLogRead {
  const out: EventLogRead = {
    envelopes: [],
    invalidLines: 0,
    unparsableLines: 0,
    truncatedTail: false,
  }
  if (raw === null || raw.length === 0) return out

  out.truncatedTail = !raw.endsWith("\n")
  const lines = raw.split("\n")
  // A trailing LF yields a final empty element; drop it so it is not counted.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  for (const line of lines) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      out.unparsableLines += 1
      continue
    }
    if (isAgentEventEnvelope(parsed)) out.envelopes.push(parsed)
    else out.invalidLines += 1
  }
  return out
}

// ---- Materialization --------------------------------------------------------

export interface MaterializedSession {
  turns: CanonicalTurn[]
  permissions: CanonicalPermissionEvent[]
  checkpoints: CanonicalCheckpoint[]
  usage?: AgentRunUsage
  /** Text of the last assistant turn, "" when there is none. */
  lastAssistantText: string
}

function accumulateUsage(
  base: AgentRunUsage | undefined,
  raw: Record<string, unknown>
): AgentRunUsage {
  const out: AgentRunUsage = { ...(base ?? {}) }
  const map: Array<[keyof AgentRunUsage, string[]]> = [
    ["inputTokens", ["inputTokens", "input_tokens", "promptTokens"]],
    ["outputTokens", ["outputTokens", "output_tokens", "completionTokens"]],
    ["cacheReadTokens", ["cacheReadTokens", "cache_read_input_tokens"]],
    ["cacheCreationTokens", ["cacheCreationTokens", "cache_creation_input_tokens"]],
    ["costUsd", ["costUsd", "total_cost_usd"]],
  ]
  for (const [key, aliases] of map) {
    for (const alias of aliases) {
      const value = raw[alias]
      if (typeof value === "number" && Number.isFinite(value)) {
        out[key] = (out[key] ?? 0) + value
        break
      }
    }
  }
  return out
}

/**
 * Rebuild canonical turns from an envelope stream.
 *
 * Grouping is by `turnId`: one `user-input` opens the user turn, and every
 * assistant-side event in the same turn folds into a single assistant turn.
 * Text is the concatenation of `text-delta`s — `thinking-delta` is deliberately
 * NOT folded in, because replaying a model's private reasoning back to it as
 * assistant text is both wrong and, on some providers, rejected.
 *
 * `usage` events are summed rather than last-wins: providers emit partial usage
 * per step, and taking the last one under-reports multi-step turns.
 */
export function materializeSession(envelopes: readonly AgentEventEnvelope[]): MaterializedSession {
  const permissions: CanonicalPermissionEvent[] = []
  const checkpoints: CanonicalCheckpoint[] = []
  let usage: AgentRunUsage | undefined

  // Assistant turn under construction, keyed by turnId.
  const assistantText = new Map<string, string>()
  const assistantCalls = new Map<string, CanonicalToolCall[]>()
  const assistantUsage = new Map<string, AgentRunUsage>()
  const assistantAt = new Map<string, string>()
  const userTurns = new Map<string, CanonicalTurn>()
  // First-sight order over ALL turn ids, so a turn whose assistant side never
  // started still lands in conversation order rather than at the end.
  const turnOrder: string[] = []
  const seenTurns = new Set<string>()

  const ensureAssistant = (turnId: string, at: string): void => {
    if (!assistantText.has(turnId)) {
      assistantText.set(turnId, "")
      assistantCalls.set(turnId, [])
      assistantAt.set(turnId, at)
    }
  }

  for (const envelope of envelopes) {
    const event: CanonicalAgentEvent = envelope.event
    const turnId = envelope.turnId
    if (!seenTurns.has(turnId)) {
      seenTurns.add(turnId)
      turnOrder.push(turnId)
    }
    switch (event.kind) {
      case "user-input":
        userTurns.set(turnId, {
          turnId: `${turnId}:user`,
          role: "user",
          text: event.text,
          at: envelope.timestamp,
        })
        break
      case "text-delta":
        ensureAssistant(turnId, envelope.timestamp)
        assistantText.set(turnId, (assistantText.get(turnId) ?? "") + event.delta)
        break
      case "tool-call": {
        ensureAssistant(turnId, envelope.timestamp)
        const calls = assistantCalls.get(turnId)
        if (calls) {
          calls.push({
            callId: event.toolCallId ?? `${turnId}:call:${calls.length}`,
            toolName: event.toolName,
            ...(event.input ? { input: event.input } : {}),
          })
        }
        break
      }
      case "tool-result": {
        ensureAssistant(turnId, envelope.timestamp)
        const calls = assistantCalls.get(turnId)
        const existing = event.toolCallId
          ? calls?.find((c) => c.callId === event.toolCallId)
          : undefined
        const resultText =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null)
        if (existing) {
          existing.resultText = resultText
          if (event.isError) existing.isError = true
        } else if (calls) {
          calls.push({
            callId: event.toolCallId ?? `${turnId}:result:${calls.length}`,
            toolName: event.toolName,
            resultText,
            ...(event.isError ? { isError: true } : {}),
          })
        }
        break
      }
      case "usage": {
        usage = accumulateUsage(usage, event.usage)
        ensureAssistant(turnId, envelope.timestamp)
        assistantUsage.set(turnId, accumulateUsage(assistantUsage.get(turnId), event.usage))
        break
      }
      case "permission-request":
        permissions.push({
          requestId: event.requestId,
          toolName: event.toolName,
          decision: "pending",
          at: envelope.timestamp,
        })
        break
      case "permission-resolved": {
        const pending = permissions.find((p) => p.requestId === event.requestId)
        if (pending) pending.decision = event.behavior === "allow" ? "allow" : "deny"
        break
      }
      case "checkpoint":
        checkpoints.push({
          checkpointId: event.checkpointId,
          afterTurnId: `${turnId}:assistant`,
        })
        break
      default:
        // Streaming/diagnostic kinds carry no canonical turn content.
        break
    }
  }

  // Splice assistant turns in after their matching user turn, in turn order.
  const assembled: CanonicalTurn[] = []
  for (const turnId of turnOrder) {
    const user = userTurns.get(turnId)
    if (user) assembled.push(user)
    const text = assistantText.get(turnId) ?? ""
    const calls = assistantCalls.get(turnId) ?? []
    const turnUsage = assistantUsage.get(turnId)
    // An assistant turn that produced neither text nor a tool call is a turn
    // that failed before any output — recording an empty one would replay as a
    // blank assistant message on resume.
    if (text.length > 0 || calls.length > 0) {
      assembled.push({
        turnId: `${turnId}:assistant`,
        role: "assistant",
        text,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
        at: assistantAt.get(turnId),
        ...(turnUsage
          ? {
              usage: {
                ...(turnUsage.inputTokens !== undefined
                  ? { inputTokens: turnUsage.inputTokens }
                  : {}),
                ...(turnUsage.outputTokens !== undefined
                  ? { outputTokens: turnUsage.outputTokens }
                  : {}),
              },
            }
          : {}),
      })
    }
  }

  let lastAssistantText = ""
  for (let i = assembled.length - 1; i >= 0; i -= 1) {
    const turn = assembled[i]
    if (turn && turn.role === "assistant") {
      lastAssistantText = turn.text
      break
    }
  }

  return {
    turns: assembled,
    permissions,
    checkpoints,
    ...(usage ? { usage } : {}),
    lastAssistantText,
  }
}
