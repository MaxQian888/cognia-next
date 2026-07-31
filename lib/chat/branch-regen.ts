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
  branchOwnerId?: string
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

/** Branch-group key for the variants of an edited user message. */
export function editBranchGroupId(originalMessageId: string): string {
  return `edit::${originalMessageId}`
}

export interface TagEditSiblingResult {
  /** The full history with the original tagged and its tail re-parented. */
  merged: UIMessage[]
  /** Group the original and its replacement share. */
  groupId: string
  /** `branchIndex` the replacement should take. */
  nextIndex: number
}

/**
 * Turn an in-place edit of a user message into a non-destructive branch.
 *
 * Editing used to `truncateAfter(..., { inclusive: true })` — the original
 * question and every reply under it were deleted from Dexie outright, so
 * "reword the question" was an irreversible way to lose the thread. Regenerate
 * already kept its alternatives; this brings editing in line.
 *
 * Two stamps do it:
 *   • the original user message joins a sibling group, so the replacement can
 *     be flipped between via the BranchNavigator;
 *   • everything after it is stamped `branchOwnerId = <original id>`, so
 *     `selectVisibleMessages` hides that tail whenever the original is not the
 *     selected sibling.
 *
 * Messages that already carry a `branchOwnerId` keep it: they hang off a
 * *nearer* ancestor, and the transitive rule in `selectVisibleMessages` walks
 * up from there. Overwriting would flatten a nested edit onto the outer one.
 */
export function tagEditSibling(
  messages: readonly UIMessage[],
  editedIdx: number
): TagEditSiblingResult {
  const original = messages[editedIdx]
  const meta = ((original as { metadata?: BranchMeta }).metadata ?? {}) as BranchMeta
  const groupId =
    typeof meta.branchGroupId === "string" ? meta.branchGroupId : editBranchGroupId(original.id)

  // Highest index already used in this group — a message may be edited many
  // times, and each variant needs its own slot.
  let maxIndex = -1
  for (const m of messages) {
    const mm = ((m as { metadata?: BranchMeta }).metadata ?? {}) as BranchMeta
    if (mm.branchGroupId === groupId) maxIndex = Math.max(maxIndex, mm.branchIndex ?? 0)
  }
  const originalIndex =
    typeof meta.branchIndex === "number" ? meta.branchIndex : Math.max(maxIndex, 0)

  const merged = messages.map((m, i) => {
    if (i < editedIdx) return m
    const mm = { ...(((m as { metadata?: BranchMeta }).metadata ?? {}) as BranchMeta) }
    if (i === editedIdx) {
      return {
        ...m,
        metadata: { ...mm, branchGroupId: groupId, branchIndex: originalIndex },
      } as UIMessage
    }
    // The tail now belongs to the original variant — unless it already hangs
    // off a nearer sibling.
    if (mm.branchOwnerId === undefined) mm.branchOwnerId = original.id
    return { ...m, metadata: mm } as UIMessage
  })

  return { merged, groupId, nextIndex: Math.max(maxIndex, originalIndex) + 1 }
}

/** senderId a team assistant message was stamped with, or "assistant". */
export function senderIdOf(m: UIMessage): string {
  const meta = (m as { metadata?: Record<string, unknown> }).metadata
  return typeof meta?.senderId === "string" ? meta.senderId : "assistant"
}
