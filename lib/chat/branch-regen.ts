import type { UIMessage } from "ai"

/**
 * Non-destructive regenerate support, shared by direct chat and team chat.
 *
 * Regenerating a turn keeps the prior assistant replies as *branches*: every
 * assistant message after the user anchor is stamped with a `branchGroupId` +
 * `branchIndex`, and `selectVisibleMessages` (stores/chat) then shows exactly
 * one message per group with a BranchNavigator to flip between siblings.
 *
 * Direct chat uses a single group per anchor (one reply per turn). A team
 * turn produces N replies — one (or more, e.g. supervisor rounds) per member
 * — so team groups are keyed per `(anchor, senderId, occurrence)` via
 * {@link teamBranchGroupId}; otherwise the one-visible-per-group rule would
 * collapse the whole team turn into a single bubble.
 */

interface BranchMeta {
  branchGroupId?: string
  branchIndex?: number
  [key: string]: unknown
}

export interface TagBranchSiblingsResult {
  /** Prefix (through the anchor) + the tagged assistant siblings. */
  merged: UIMessage[]
  /** Per group: the branchIndex the NEXT (regenerated) reply should take. */
  nextIndexByGroup: Map<string, number>
}

/**
 * Stamp every assistant message after `lastUserIdx` with branch metadata.
 * Prior tags are preserved (only missing fields are filled in); non-assistant
 * messages after the anchor are dropped, matching the pre-branching truncate
 * semantics for the regenerated tail.
 *
 * `groupIdOf` maps a sibling to its branch group and may be stateful (team
 * chat closes over a per-member occurrence counter).
 */
export function tagBranchSiblings(
  messages: readonly UIMessage[],
  lastUserIdx: number,
  groupIdOf: (m: UIMessage) => string
): TagBranchSiblingsResult {
  const prefix = messages.slice(0, lastUserIdx + 1)
  const siblings = messages.slice(lastUserIdx + 1).filter((m) => m.role === "assistant")
  const nextIndexByGroup = new Map<string, number>()

  const tagged = siblings.map((m) => {
    const meta = ((m as { metadata?: BranchMeta }).metadata ?? {}) as BranchMeta
    const group = typeof meta.branchGroupId === "string" ? meta.branchGroupId : groupIdOf(m)
    const fallbackIndex = nextIndexByGroup.get(group) ?? 0
    const index = typeof meta.branchIndex === "number" ? meta.branchIndex : fallbackIndex
    nextIndexByGroup.set(group, Math.max(fallbackIndex, index + 1))
    return {
      ...m,
      metadata: { ...meta, branchGroupId: group, branchIndex: index },
    } as UIMessage
  })

  return { merged: [...prefix, ...tagged], nextIndexByGroup }
}

/**
 * Branch-group key for one member's k-th reply within a regenerated team
 * turn. Each distinct message position after the anchor gets its own group so
 * supervisor multi-round turns don't hide their earlier round.
 */
export function teamBranchGroupId(anchorId: string, senderId: string, occurrence: number): string {
  return `${anchorId}::${senderId}::${occurrence}`
}

/** senderId a team assistant message was stamped with, or "assistant". */
export function senderIdOf(m: UIMessage): string {
  const meta = (m as { metadata?: Record<string, unknown> }).metadata
  return typeof meta?.senderId === "string" ? meta.senderId : "assistant"
}
