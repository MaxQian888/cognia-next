/**
 * Writes finished voice turns into the chat history.
 *
 * A voice session that leaves no trace is a session the user cannot search,
 * resume in text, or share. But it is also the one place where writing *too*
 * much does damage, so three rules are enforced here rather than left to the
 * caller:
 *
 * - **Final turns only.** `assistantDraft` is a partial transcript that changes
 *   on every delta; persisting it would write a message per audio frame.
 *
 * - **No audio.** Only transcripts are stored. Audio bytes are large, are not
 *   searchable, and were never something the user agreed to keep.
 *
 * - **No workflow fan-out.** Each turn is stamped `triggerWorkflows: false`, so
 *   `lib/db/messages.ts` does not fire `trigger.chat.message` for speech that
 *   never went through the send path. The flag has to be on the FIRST write —
 *   metadata added later cannot retract a dispatch that already happened.
 *
 * Tool calls ride along as `dynamic-tool` parts on the assistant message.
 * `UIMessage["role"]` has no `"tool"` member, so a tool turn is not its own row.
 */

import type { UIMessage } from "ai"

import type { LiveVoiceTurn } from "../realtime-session"
import type { LiveVoiceMessageMetadata, PreparedRealtimeSession } from "./types"

/** Identifies the provider/model/region a turn was spoken to. */
export type LiveVoiceTurnProvenance = Pick<
  PreparedRealtimeSession,
  "provider" | "modelOrResource" | "region"
>

export interface LiveVoiceTurnsToMessagesOptions {
  turns: readonly LiveVoiceTurn[]
  provenance: LiveVoiceTurnProvenance
  /** Wall clock for the first turn; later turns are spaced 1ms apart. */
  startedAt: number
}

/**
 * Message ids are derived from the provider's item id so re-persisting the
 * same session updates rows rather than duplicating them.
 */
export function liveVoiceMessageId(sessionId: string, turnId: string): string {
  return `voice:${sessionId}:${turnId}`
}

function metadataFor(
  sessionId: string,
  provenance: LiveVoiceTurnProvenance,
  createdAt: number
): LiveVoiceMessageMetadata & { sessionId: string; createdAt: number } {
  return {
    provider: provenance.provider,
    modelOrResource: provenance.modelOrResource,
    region: provenance.region,
    modality: "audio",
    final: true,
    triggerWorkflows: false,
    // Hoisted keys — `persistMessages` reads and then strips these.
    sessionId,
    createdAt,
  }
}

/**
 * Project finished turns onto `UIMessage`s ready for `persistMessages`.
 *
 * Turns with no text survive nowhere: an empty transcript is what a turn looks
 * like when the provider heard only silence.
 */
export function liveVoiceTurnsToMessages(
  sessionId: string,
  options: LiveVoiceTurnsToMessagesOptions
): UIMessage[] {
  const messages: UIMessage[] = []

  options.turns.forEach((turn, index) => {
    const text = turn.text?.trim()
    if (!text) return
    // Ordering has to be stable and strictly increasing: `listMessages` sorts
    // by createdAt, and a whole voice session lands within the same millisecond.
    const createdAt = options.startedAt + index

    messages.push({
      id: liveVoiceMessageId(sessionId, turn.id),
      role: turn.role,
      parts: [{ type: "text", text }],
      metadata: metadataFor(sessionId, options.provenance, createdAt),
    } as UIMessage)
  })

  return messages
}

export interface PersistLiveVoiceTurnsOptions extends LiveVoiceTurnsToMessagesOptions {
  sessionId: string
  /**
   * Messages already in the session. `persistMessages` reconciles the FULL
   * list and deletes anything missing from it, so the prior history must be
   * carried through or the voice turns would wipe the conversation. Left
   * unset it is read from Dexie — the default exists precisely so a caller
   * cannot reach for `[]` and silently delete the thread.
   */
  existing?: readonly UIMessage[]
  /** Seam for tests; defaults to `lib/db/messages.listMessages`. */
  loadExisting?: (sessionId: string) => Promise<UIMessage[]>
  /** Seam for tests; defaults to `lib/db/messages.persistMessages`. */
  persist?: (sessionId: string, messages: UIMessage[]) => Promise<void>
}

/**
 * Append this session's finished voice turns to its chat history.
 *
 * Returns the number of turns written. A session where nothing was said writes
 * nothing at all rather than an empty row.
 */
export async function persistLiveVoiceTurns(
  options: PersistLiveVoiceTurnsOptions
): Promise<number> {
  const voiceMessages = liveVoiceTurnsToMessages(options.sessionId, options)
  if (voiceMessages.length === 0) return 0

  const persist =
    options.persist ??
    (async (sessionId, messages) => {
      const { persistMessages } = await import("@/lib/db/messages")
      await persistMessages(sessionId, messages)
    })
  const loadExisting =
    options.loadExisting ??
    (async (sessionId) => {
      const { listMessages } = await import("@/lib/db/messages")
      return listMessages(sessionId)
    })

  const existing = options.existing ?? (await loadExisting(options.sessionId))

  // Re-persisting a turn id replaces the earlier row rather than duplicating it.
  const byId = new Map<string, UIMessage>()
  for (const message of [...existing, ...voiceMessages]) byId.set(message.id, message)

  await persist(options.sessionId, [...byId.values()])
  return voiceMessages.length
}
