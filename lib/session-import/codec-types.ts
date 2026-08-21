// Session codec contract (ADR-0090 Phase 8).
//
// EXTENDS — does not replace — `AgentSessionSourceAdapter`: an adapter that
// declares a `codec` can convert its parsed `ImportedConversation` into the
// runtime-neutral `CanonicalSession` (with an honest `SessionLossReport`),
// and MAY declare a `materialize` capability for the reverse direction. An
// adapter without a codec is an honest import-only source. Per the R1 spike
// verdict (session-materialize.spike.live.test.mjs), claude-code has no
// public create-from-external-messages API, so its materialize path is
// `contextual`: a replay prompt that seeds a NEW native session — never a
// forged private transcript.

import type {
  CanonicalSession,
  CanonicalToolCall,
  CanonicalTurn,
  SessionFidelity,
  SessionLossEntry,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import type { ImportedConversation } from "@/lib/data/importers/types"

export interface SessionCodecConversion {
  session: CanonicalSession
  loss: SessionLossReport
}

export interface SessionCodec {
  /** Fidelity of `toCanonical` for this source's transcripts. */
  importFidelity: SessionFidelity
  /** Convert one parsed conversation into the canonical record + loss report. */
  toCanonical(conversation: ImportedConversation): SessionCodecConversion
  /**
   * Reverse direction, when a PUBLIC runtime path exists. Absent =
   * materialization unsupported (import-only source) — callers must not
   * fake it.
   *
   * DORMANT AT RUNTIME. `buildReplayPrompt` has no production caller: the only
   * exercisers are `tests/conformance/cases/session-materialize.test.mjs` and
   * this module's own unit test. It is kept because ADR-0090 §8 makes it part
   * of the recovery design (canonical history may seed a new runtime session)
   * and because the byte-pinned conformance case is the tripwire for an SDK
   * that later grows a real import API. The dormancy is LABELLED in the UI —
   * `FidelityReport`'s `reverseFidelity` line — so it cannot be mistaken for a
   * capability the app actually offers, and pinned by the "no production
   * caller" assertion in `codec-types.test.ts`.
   */
  materialize?: {
    fidelity: SessionFidelity
    /**
     * Build the replay prompt that seeds a NEW runtime session with the
     * canonical history (the `contextual` path — the only one the R1 spike
     * sanctions for claude-code).
     */
    buildReplayPrompt(session: CanonicalSession): string
  }
}

// ---- Shared conversion core -------------------------------------------------

interface RawPart {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
  state?: string
}

function toolCallFromPart(part: RawPart, index: number): CanonicalToolCall {
  const toolName =
    part.type === "dynamic-tool"
      ? (part.toolName ?? "tool")
      : (part.type?.replace(/^tool-/, "") ?? "tool")
  let resultText: string | undefined
  if (part.output !== undefined) {
    try {
      resultText = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
    } catch {
      resultText = String(part.output)
    }
  } else if (part.errorText) {
    resultText = part.errorText
  }
  return {
    callId: part.toolCallId ?? `call-${index}`,
    toolName,
    ...(part.input && typeof part.input === "object"
      ? { input: part.input as Record<string, unknown> }
      : {}),
    ...(resultText !== undefined ? { resultText } : {}),
    ...(part.errorText || part.state === "output-error" ? { isError: true } : {}),
  }
}

/**
 * Shared `ImportedConversation` → `CanonicalSession` conversion. Text and
 * tool parts convert losslessly; reasoning is dropped WITH a loss entry
 * (thinking is runtime-private); any other part kind is reported dropped by
 * type. Codecs wrap this with their source id and fidelity.
 */
export function conversationToCanonical(
  conversation: ImportedConversation,
  options: { sourceRuntime: string; importFidelity: SessionFidelity }
): SessionCodecConversion {
  const losses: SessionLossEntry[] = []
  const turns: CanonicalTurn[] = []

  for (const [index, message] of conversation.messages.entries()) {
    const parts = (message.parts ?? []) as RawPart[]
    const textPieces: string[] = []
    const toolCalls: CanonicalToolCall[] = []
    for (const [partIndex, part] of parts.entries()) {
      if (part.type === "text" && typeof part.text === "string") {
        textPieces.push(part.text)
      } else if (part.type === "dynamic-tool" || part.type?.startsWith("tool-")) {
        toolCalls.push(toolCallFromPart(part, partIndex))
      } else if (part.type === "reasoning") {
        losses.push({
          path: `turns[${index}].reasoning`,
          kind: "dropped",
          detail: "runtime-private thinking is not carried into the canonical record",
        })
      } else if (part.type) {
        losses.push({
          path: `turns[${index}].parts[${partIndex}]`,
          kind: "dropped",
          detail: part.type,
        })
      }
    }
    const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
    turns.push({
      turnId: message.id || `turn-${index}`,
      role,
      text: textPieces.join(""),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(typeof message.metadata?.createdAt === "string"
        ? { at: message.metadata.createdAt as string }
        : {}),
    })
  }

  if (conversation.nested && conversation.nested.length > 0) {
    losses.push({
      path: "nested",
      kind: "summarized",
      detail: `${conversation.nested.length} nested subagent transcript(s) not inlined`,
    })
  }

  const session: CanonicalSession = {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: `canon:${options.sourceRuntime}:${conversation.session.id}`,
      sourceRuntime: options.sourceRuntime,
      ...(conversation.session.sdkSessionId
        ? { runtimeBinding: { nativeSessionId: conversation.session.sdkSessionId } }
        : {}),
      ...(conversation.session.title ? { title: conversation.session.title } : {}),
      createdAt: new Date(conversation.session.createdAt ?? Date.now()).toISOString(),
      updatedAt: new Date(conversation.session.updatedAt ?? Date.now()).toISOString(),
      turnCount: turns.length,
      importFidelity: options.importFidelity,
      sequenceDigest: computeSequenceDigest(turns),
    },
    turns,
  }

  return { session, loss: { fidelity: options.importFidelity, losses } }
}

/**
 * The shared `contextual` replay prompt: frames the canonical history so a
 * NEW runtime session continues the conversation. Deliberately plain text —
 * no runtime-private formats.
 */
export function buildReplayPrompt(session: CanonicalSession): string {
  const lines: string[] = [
    `This continues a previous conversation imported from ${session.header.sourceRuntime}` +
      (session.header.title ? ` ("${session.header.title}")` : "") +
      ". Transcript so far:",
    "",
  ]
  for (const turn of session.turns) {
    const tools =
      turn.toolCalls && turn.toolCalls.length > 0
        ? ` [tools: ${turn.toolCalls.map((c) => c.toolName).join(", ")}]`
        : ""
    lines.push(`${turn.role}: ${turn.text}${tools}`)
  }
  lines.push("", "Continue the conversation from this point.")
  return lines.join("\n")
}
