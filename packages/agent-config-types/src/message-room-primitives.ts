/**
 * Conversation primitives carried on a message row's `metadata`
 * (ADR-0177, batch 2).
 *
 * Both live under `metadata` on purpose. The row has two hand-written
 * builders (`toStoredMessageRow` and `commitMessageDelta` in
 * `lib/db/messages.ts`) plus a hoist list for the columns they mirror, and a
 * top-level column has to be threaded through all three or it is silently
 * dropped on the next persist. `metadata` is copied whole by every writer and
 * by the companion sync mirror, so a field placed there survives every path
 * without a schema bump. Neither field is indexed.
 */

/**
 * A reply to another message of the same conversation, the way Slack and
 * Telegram quote a message: a reference plus a preview that stays readable
 * when the target is gone (compacted, deleted, or never mirrored).
 */
export interface MessageReplyTo {
  /**
   * The stored id of the message replied to. For an inbound IM reply whose
   * parent was never stored locally this is the platform's message id, and
   * `platformMessageId` says so, so a renderer can still show the quote and
   * simply not offer a jump.
   */
  messageId: string
  /** One line of the target's text, already capped. */
  preview: string
  /** Set when the reference came over an IM connector, for outbound mirroring. */
  platformMessageId?: string
}

/** The upper bound `buildReplyPreview` clamps a preview to. */
export const REPLY_PREVIEW_MAX = 120

/** One-line, length-capped preview of a message's text parts. */
export function buildReplyPreview(parts: readonly unknown[] | undefined): string {
  let out = ""
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    if ((part as { type?: unknown }).type !== "text") continue
    const text = (part as { text?: unknown }).text
    if (typeof text === "string") out += (out ? " " : "") + text
  }
  return out.replace(/\s+/g, " ").trim().slice(0, REPLY_PREVIEW_MAX)
}

/**
 * One emoji on a message and who put it there.
 *
 * Same shape as `CommentReaction` on canvas comments, so the two surfaces read
 * alike. `actorIds` are opaque: the local user, an IM member as
 * `<platform>:<remoteUserId>`, later a `usr_` id from the collab server.
 */
export interface MessageReaction {
  emoji: string
  actorIds: string[]
  /**
   * Per actor, the platform's own id for the reaction when the adapter hands
   * one back on `addReaction`. Needed to remove exactly that reaction later
   * (Lark, Matrix). Absent for platforms that key removal by emoji.
   */
  platformReactionIds?: Record<string, string>
}

/** The reactor id the local user writes under. */
export const LOCAL_REACTOR_ID = "local"

/** The reactor id an IM member writes under, so two platforms never collide. */
export function platformReactorId(platform: string, remoteUserId: string): string {
  return `${platform}:${remoteUserId}`
}

export interface ReactionChange {
  emoji: string
  actorId: string
  /** `true` adds the actor to the emoji, `false` removes it. */
  add: boolean
  platformReactionId?: string
}

/**
 * The reaction list after `change`, or the same array when nothing changed
 * (adding what is already there, removing what is not). Never mutates.
 */
export function applyReactionChange(
  reactions: readonly MessageReaction[] | undefined,
  change: ReactionChange
): MessageReaction[] {
  const current = reactions ?? []
  const index = current.findIndex((reaction) => reaction.emoji === change.emoji)
  if (change.add) {
    if (index >= 0) {
      const existing = current[index]!
      const already = existing.actorIds.includes(change.actorId)
      const sameRef =
        !change.platformReactionId ||
        existing.platformReactionIds?.[change.actorId] === change.platformReactionId
      if (already && sameRef) return current as MessageReaction[]
      const next = [...current]
      next[index] = {
        ...existing,
        actorIds: already ? existing.actorIds : [...existing.actorIds, change.actorId],
        ...withPlatformRef(existing.platformReactionIds, change),
      }
      return next
    }
    return [
      ...current,
      {
        emoji: change.emoji,
        actorIds: [change.actorId],
        ...withPlatformRef(undefined, change),
      },
    ]
  }
  if (index < 0) return current as MessageReaction[]
  const existing = current[index]!
  if (!existing.actorIds.includes(change.actorId)) return current as MessageReaction[]
  const actorIds = existing.actorIds.filter((id) => id !== change.actorId)
  const next = [...current]
  if (actorIds.length === 0) {
    next.splice(index, 1)
    return next
  }
  const { platformReactionIds: previousIds, ...rest } = existing
  const platformReactionIds = previousIds
    ? Object.fromEntries(Object.entries(previousIds).filter(([id]) => id !== change.actorId))
    : undefined
  next[index] = {
    ...rest,
    actorIds,
    ...(platformReactionIds && Object.keys(platformReactionIds).length > 0
      ? { platformReactionIds }
      : {}),
  }
  return next
}

function withPlatformRef(
  ids: Record<string, string> | undefined,
  change: ReactionChange
): Pick<MessageReaction, "platformReactionIds"> {
  if (!change.platformReactionId) return ids ? { platformReactionIds: ids } : {}
  return { platformReactionIds: { ...(ids ?? {}), [change.actorId]: change.platformReactionId } }
}

/** True when `actorId` has put `emoji` on the message. */
export function hasReacted(
  reactions: readonly MessageReaction[] | undefined,
  emoji: string,
  actorId: string
): boolean {
  return (
    reactions?.some(
      (reaction) => reaction.emoji === emoji && reaction.actorIds.includes(actorId)
    ) ?? false
  )
}

/**
 * The reactions as one transcript line, `👍 2 · ❤️ 1`, or `""` when there are
 * none. This is what a room member reads, so an agent can see that the user
 * liked a reply without being handed the actor ids.
 */
export function formatReactionSummary(reactions: readonly MessageReaction[] | undefined): string {
  if (!reactions || reactions.length === 0) return ""
  return reactions
    .filter((reaction) => reaction.actorIds.length > 0)
    .map((reaction) => `${reaction.emoji} ${reaction.actorIds.length}`)
    .join(" · ")
}
