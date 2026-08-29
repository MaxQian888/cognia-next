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
  filename?: string
  mediaType?: string
  url?: string
  agentId?: string
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usageFromMetadata(metadata: Record<string, unknown> | undefined) {
  const raw = metadata?.usage
  if (!raw || typeof raw !== "object") return undefined
  const usage = raw as Record<string, unknown>
  const mapped = {
    inputTokens: finiteNumber(usage.inputTokens ?? usage.input_tokens),
    outputTokens: finiteNumber(usage.outputTokens ?? usage.output_tokens),
    cachedInputTokens: finiteNumber(
      usage.cachedInputTokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens
    ),
    cachedOutputTokens: finiteNumber(usage.cachedOutputTokens ?? usage.cached_output_tokens),
    reasoningTokens: finiteNumber(usage.reasoningTokens ?? usage.thoughtsTokens),
    toolTokens: finiteNumber(usage.toolTokens),
    totalTokens: finiteNumber(usage.totalTokens ?? usage.total_tokens),
    costUsd: finiteNumber(usage.costUsd ?? metadata?.costUsd),
  }
  const present = Object.fromEntries(
    Object.entries(mapped).filter(([, value]) => value !== undefined)
  )
  return Object.keys(present).length > 0 ? present : undefined
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
    ...(part.agentId ? { taskId: part.agentId } : {}),
    ...(part.state === "input-available"
      ? { status: "pending" as const }
      : part.state === "output-error"
        ? { status: "failed" as const }
        : part.state === "output-available"
          ? { status: "completed" as const }
          : {}),
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
    const reasoningPieces: string[] = []
    const richParts: NonNullable<CanonicalTurn["parts"]> = []
    const toolCalls: CanonicalToolCall[] = []
    for (const [partIndex, part] of parts.entries()) {
      if (part.type === "text" && typeof part.text === "string") {
        textPieces.push(part.text)
      } else if (part.type === "dynamic-tool" || part.type?.startsWith("tool-")) {
        toolCalls.push(toolCallFromPart(part, partIndex))
      } else if (part.type === "reasoning") {
        if (typeof part.text === "string") reasoningPieces.push(part.text)
      } else if (part.type === "file" && typeof part.url === "string") {
        if (part.url.startsWith("data:")) {
          losses.push({
            path: `turns[${index}].parts[${partIndex}]`,
            kind: "approximated",
            detail: "inline file body omitted from canonical record",
          })
        } else {
          richParts.push({
            type: "file",
            name: part.filename ?? "file",
            uri: part.url,
            ...(part.mediaType ? { mediaType: part.mediaType } : {}),
          })
        }
      } else if (part.type) {
        losses.push({
          path: `turns[${index}].parts[${partIndex}]`,
          kind: "dropped",
          detail: part.type,
        })
      }
    }
    const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
    const metadata = message.metadata as Record<string, unknown> | undefined
    const usage = usageFromMetadata(metadata)
    turns.push({
      turnId: message.id || `turn-${index}`,
      role,
      text: textPieces.join(""),
      ...(reasoningPieces.length > 0 ? { reasoning: reasoningPieces.join("") } : {}),
      ...(richParts.length > 0 ? { parts: richParts } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(typeof metadata?.model === "string" ? { model: metadata.model } : {}),
      ...(usage ? { usage } : {}),
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
      ...(conversation.session.importSourceVersion || conversation.session.importSourceRevision
        ? {
            source: {
              ...(conversation.session.importSourceVersion
                ? { version: conversation.session.importSourceVersion }
                : {}),
              ...(conversation.session.importSourceRevision
                ? { revision: conversation.session.importSourceRevision }
                : {}),
            },
          }
        : {}),
      ...(conversation.session.importRuntimeBinding
        ? { runtimeBinding: conversation.session.importRuntimeBinding }
        : conversation.session.sdkSessionId
          ? { runtimeBinding: { nativeSessionId: conversation.session.sdkSessionId } }
          : {}),
      ...(conversation.session.importRelation
        ? { lineage: conversation.session.importRelation }
        : {}),
      ...(conversation.session.importLifecycle
        ? { lifecycle: conversation.session.importLifecycle }
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
