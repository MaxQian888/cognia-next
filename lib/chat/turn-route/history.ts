/**
 * Mixed-runtime history: what a lane has NOT seen of its own conversation.
 *
 * Every lane keeps its own memory of a conversation, and none of them reads
 * Cognia's transcript back on a resumed turn:
 *
 *   - the builtin lane resumes its SDK session (`resumeSessionId`), and the
 *     sidecar's AI SDK runner accumulates its own conversation per session;
 *   - an external agent resumes ITS native session when the conversation still
 *     names it (`session.externalAgentSession`).
 *
 * So once `@codex` answers one turn in a builtin conversation, the next builtin
 * turn resumes an SDK session that never saw Codex's reply — and the next
 * `@codex` turn resumes a Codex session that never saw the builtin replies in
 * between. The conversation reads as one thread and each runtime would answer
 * from a different one.
 *
 * Switching a conversation's lane already hands the transcript over when the
 * target has no matching session (the external branch of the send path). This
 * covers the remaining case: the lane HAS a session, and other runtimes spoke
 * since it last did. What they said is projected through the same
 * `buildHandoffContext` the lane switch uses, and handed to the lane with this
 * turn.
 *
 * Pure apart from {@link foreignTurnsHandoffText}, which may ask a model for a
 * summary through the client its caller hands in. No store, no React.
 */

import type { UIMessage } from "ai"
import type { SendContent } from "@cognia/agent-config-types"
import { runMetadataOf } from "@/lib/chat/message-run-metadata"
import type { LlmClient } from "@/lib/twin/distill/llm"

/** The two kinds of memory a turn can land in. A host lane is an external agent too. */
export type LaneMemory = "builtin" | "external"

/**
 * Which kind of lane produced an assistant message, from its sealed run
 * metadata. `null` when the message carries no provider (a legacy row, a
 * partial reply that never sealed) — such a message is evidence of nothing.
 */
export function laneMemoryOf(message: UIMessage): LaneMemory | null {
  if (message.role !== "assistant") return null
  const providerId = runMetadataOf(message)?.providerId
  if (!providerId) return null
  return providerId === "external" ? "external" : "builtin"
}

/**
 * The messages `lane` has not seen, when another lane answered in the
 * meantime; empty when there is nothing to hand over.
 *
 * Starts after the last reply `lane` produced (a lane that never answered has
 * seen nothing) and ends at the last reply another lane produced. Anything
 * after that final foreign reply is a user message this turn delivers itself —
 * a queued follow-up being replayed — and repeating it in the handoff would
 * only say it twice.
 *
 * `messages` is the VISIBLE transcript before the outgoing turn: branch
 * siblings the user switched away from were never part of this thread.
 */
export function unseenForeignTurns(messages: readonly UIMessage[], lane: LaneMemory): UIMessage[] {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (laneMemoryOf(messages[index]) === lane) {
      start = index + 1
      break
    }
  }
  const tail = messages.slice(start)
  let lastForeign = -1
  tail.forEach((message, index) => {
    const memory = laneMemoryOf(message)
    if (memory && memory !== lane) lastForeign = index
  })
  if (lastForeign < 0) return []
  return tail
    .slice(0, lastForeign + 1)
    .filter((message) => message.role === "user" || message.role === "assistant")
}

/**
 * Put a handoff in front of the text a runtime will read, with the label the
 * external lane's continuation already uses, so both directions read the same.
 */
export function withForeignTurnsContext(context: string, request: string): string {
  return context ? `${foreignTurnsHeader(context)}\n${request}` : request
}

/** The handoff and the label, with nothing after them yet. */
function foreignTurnsHeader(context: string): string {
  return `${context}\n\nCurrent user request:`
}

/**
 * The builtin lane's form of {@link withForeignTurnsContext}: the handoff rides
 * the turn's CONTENT, not its system prompt, because content is what the SDK
 * session records and replays on every later resume (the same reason the reply
 * line is prefixed there — `lib/chat/reply-to.ts`). A system-prompt addition
 * would be gone again on the next turn.
 *
 * `attachmentCount` is how many attachment blocks lead `content` (none when a
 * reply line leads it). Files leading the turn get the handoff as a block of
 * its own in front of them, labelled as the external lane labels its request
 * (the files' text, then the question). Folding it into the first text block
 * would write another runtime's conversation into an attached document and
 * call that document the request.
 */
export function prefixForeignTurnsContext(
  content: SendContent,
  context: string,
  attachmentCount = 0
): SendContent {
  if (!context) return content
  if (typeof content === "string") return withForeignTurnsContext(context, content)
  if (attachmentCount > 0) return [{ type: "text", text: foreignTurnsHeader(context) }, ...content]
  const index = content.findIndex((block) => block.type === "text")
  if (index < 0) return [{ type: "text", text: context }, ...content]
  const block = content[index] as { type: "text"; text: string }
  const next = [...content]
  next[index] = { ...block, text: withForeignTurnsContext(context, block.text) }
  return next
}

/**
 * The handoff text for `messages`, through the same projection the lane
 * switch uses (`lib/chat/handoff-context.ts`).
 *
 * Over budget, the projection asks for a real summary, as a live lane switch
 * does. When the summary is unavailable only because no model can run here or
 * the model answered with nothing, the head/tail projection is used as it is:
 * it already carries an explicit notice that history was omitted, which is an
 * honest handoff — handing over nothing would not be.
 *
 * Every other failure is thrown, the PII refusal above all, and the caller
 * fails the turn with it exactly as a lane switch's handoff does. The gate
 * refused this material on its way to a model; handing the lane the excerpt
 * of that same material instead would route around the refusal.
 *
 * `client` is lazy so the model client is only built when a summary is needed.
 */
export async function foreignTurnsHandoffText(
  messages: readonly UIMessage[],
  options: { client: () => Promise<LlmClient | null>; signal?: AbortSignal }
): Promise<string> {
  if (messages.length === 0) return ""
  const { buildHandoffContext, prepareHandoffContext } = await import("@/lib/chat/handoff-context")
  const projected = buildHandoffContext(messages)
  if (!projected.losses.some((loss) => loss.kind === "budget")) return projected.text
  try {
    return (
      await prepareHandoffContext(messages, {
        client: await options.client(),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    ).text
  } catch (error) {
    if (!isExcerptFallback(error)) throw error
    return projected.text
  }
}

/** How `prepareHandoffContext` names an unavailable summary: this, then the reason. */
const SUMMARY_UNAVAILABLE_PREFIX = "handoff_context_summary_unavailable:"

/**
 * The unavailable-summary reasons the excerpt stands in for: no model can run
 * here (`no-client`), or it answered with nothing (`no-output`). Not `pii`, and
 * not a failed or aborted call.
 */
const EXCERPT_FALLBACK_REASONS: ReadonlySet<string> = new Set(["no-client", "no-output"])

function isExcerptFallback(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.startsWith(SUMMARY_UNAVAILABLE_PREFIX)) {
    return false
  }
  return EXCERPT_FALLBACK_REASONS.has(error.message.slice(SUMMARY_UNAVAILABLE_PREFIX.length))
}
