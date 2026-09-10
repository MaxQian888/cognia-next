/**
 * Message reactions (ADR-0177, batch 2).
 *
 * One entry point for "the local user toggled an emoji on a message". The row
 * is the record (`metadata.reactions`, written through `setMessageReaction`
 * so a concurrent inbound reaction is never lost), and when the message came
 * over an IM connector the same toggle is mirrored to the platform through the
 * adapter's `addReaction` / `removeReaction`, so the person on Telegram sees
 * the thumbs-up too.
 *
 * # Where the mirror runs
 *
 * The mirror needs a connector runtime, which only the desktop host and the
 * headless brain own. The same route the Inbox write plane resolves says
 * which shell this is: `local` mirrors through the bus, `unavailable` (a
 * standalone tab with no host at all) writes the row and has nothing to
 * mirror to, and `remote` (a paired phone or web companion) writes nothing,
 * because its `messages` rows are a mirror of the host's and the host would
 * overwrite the reaction on the next sync. The picker says so instead of
 * hiding (see `components/chat/message-reactions.tsx`).
 */

import type { UIMessage } from "ai"
import {
  hasReacted,
  LOCAL_REACTOR_ID,
  type MessageReaction,
  type ReactionChange,
} from "@cognia/agent-config-types"

import { REACTION_EMOJIS } from "@/lib/canvas/constants"
import { resolveInboxWriteRoute, type InboxWriteRoute } from "@/lib/connectors/inbox-writes/route"
import { setMessageReaction } from "@/lib/db/messages"
import { reflectMessageReactions } from "./reactions-store"

/** The picker's palette, shared with canvas comments so the two read alike. */
export const MESSAGE_REACTION_EMOJIS: readonly string[] = REACTION_EMOJIS

/** The reactions on a message, or an empty list. */
export function readReactions(message: { metadata?: unknown }): MessageReaction[] {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return []
  const value = (meta as { reactions?: unknown }).reactions
  return Array.isArray(value) ? (value as MessageReaction[]) : []
}

/** The IM address of a message that arrived over a connector, if it did. */
export function platformAddressOf(message: {
  metadata?: unknown
}): { adapterId: string; platformMessageId: string } | null {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return null
  const pm = (meta as { platformMessage?: unknown }).platformMessage
  if (!pm || typeof pm !== "object") return null
  const { adapterId, messageId } = pm as { adapterId?: unknown; messageId?: unknown }
  if (typeof adapterId !== "string" || !adapterId) return null
  if (typeof messageId !== "string" || !messageId) return null
  return { adapterId, platformMessageId: messageId }
}

/** What a shell may do with reactions, from the same route the Inbox writes use. */
export type ReactionAbility = "write-and-mirror" | "write-only" | "host-only"

export function reactionAbilityFor(route: InboxWriteRoute): ReactionAbility {
  if (route === "local") return "write-and-mirror"
  if (route === "remote") return "host-only"
  return "write-only"
}

export interface ReactionMirror {
  add: (adapterId: string, platformMessageId: string, emoji: string) => Promise<string | undefined>
  remove: (
    adapterId: string,
    platformMessageId: string,
    reactionRef: { reactionId?: string; emoji: string }
  ) => Promise<void>
}

/** The bus-backed mirror, loaded on first use so the renderer never imports the bus eagerly. */
async function busMirror(): Promise<ReactionMirror> {
  const { getBus } = await import("@/lib/connectors/bus")
  return {
    add: async (adapterId, platformMessageId, emoji) => {
      const result = await getBus().addReactionOutbound(adapterId, platformMessageId, emoji)
      if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? "unsupported")
      return result.reactionId
    },
    remove: async (adapterId, platformMessageId, ref) => {
      // Adapters that hand back no reaction id key removal by the emoji itself.
      const result = await getBus().removeReactionOutbound(
        adapterId,
        platformMessageId,
        ref.reactionId ?? ref.emoji
      )
      if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? "unsupported")
    },
  }
}

export interface ToggleReactionInput {
  sessionId: string
  message: Pick<UIMessage, "id"> & { metadata?: unknown }
  emoji: string
  actorId?: string
  /** Test seam. Production resolves the route and the bus itself. */
  deps?: { route?: () => InboxWriteRoute; mirror?: () => Promise<ReactionMirror> }
}

export interface ToggleReactionResult {
  reactions: MessageReaction[] | null
  added: boolean
  /** `"skipped"` when there was nothing to mirror to, `"failed"` carries the reason. */
  mirror: "done" | "skipped" | { failed: string }
}

/**
 * Toggle `emoji` for `actorId` on the message and mirror the change to the
 * platform when this shell can. Throws when the shell must not write at all.
 */
export async function toggleMessageReaction(
  input: ToggleReactionInput
): Promise<ToggleReactionResult> {
  const actorId = input.actorId ?? LOCAL_REACTOR_ID
  const route = (input.deps?.route ?? resolveInboxWriteRoute)()
  const ability = reactionAbilityFor(route)
  if (ability === "host-only") throw new ReactionNeedsHostError()

  const current = readReactions(input.message)
  const add = !hasReacted(current, input.emoji, actorId)
  const address = platformAddressOf(input.message)
  const change: ReactionChange = { emoji: input.emoji, actorId, add }

  let mirror: ToggleReactionResult["mirror"] = "skipped"
  if (ability === "write-and-mirror" && address) {
    const mirrorImpl = await (input.deps?.mirror ?? busMirror)()
    try {
      if (add) {
        const reactionId = await mirrorImpl.add(
          address.adapterId,
          address.platformMessageId,
          input.emoji
        )
        if (reactionId) change.platformReactionId = reactionId
      } else {
        const reactionId = current.find((reaction) => reaction.emoji === input.emoji)
          ?.platformReactionIds?.[actorId]
        await mirrorImpl.remove(address.adapterId, address.platformMessageId, {
          reactionId,
          emoji: input.emoji,
        })
      }
      mirror = "done"
    } catch (error) {
      // The local record still changes: the user did react, and the row is
      // what the room and the transcript read. The caller says the platform
      // did not get it.
      mirror = { failed: error instanceof Error ? error.message : String(error) }
    }
  }

  const reactions = await setMessageReaction(input.sessionId, input.message.id, change)
  if (reactions) reflectMessageReactions(input.sessionId, input.message.id, reactions)
  return { reactions, added: add, mirror }
}

export class ReactionNeedsHostError extends Error {
  constructor() {
    super("reactions are written by the host that owns this conversation")
    this.name = "ReactionNeedsHostError"
  }
}
