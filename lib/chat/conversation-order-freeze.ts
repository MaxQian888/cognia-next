import type { ChatSession } from "@cognia/agent-config-types"

import {
  conversationSectionKey,
  type ConversationSection,
} from "@/lib/chat/conversation-list-model"

/**
 * Holding the conversation list still while someone is reading it.
 *
 * The list is bound to a live query and ordered by last activity, so a
 * background conversation — an IM message arriving, an agent run finishing —
 * re-emits the query and slides rows under the cursor. The row you were
 * reaching for is somewhere else by the time you click, and in date-bucket
 * grouping it can change section entirely.
 *
 * The fix is not to stop listening. It is to keep the *order* you were shown
 * until you are plausibly done with it, while letting everything else through:
 *
 * - **Order is frozen.** Rows keep the relative positions they had when the
 *   freeze began.
 * - **Additions are not.** A conversation created while frozen appears, at the
 *   place the live order puts it relative to the frozen rows — the same
 *   slot-in rule the manual drag order uses. Freezing insertions would fight
 *   the new-conversation reveal, which must always be able to show a chat the
 *   user just created.
 * - **Removals are not.** A deleted or archived row disappears at once. Holding
 *   it would leave a row that opens nothing — worse than a row that moved.
 *
 * Pure and total: given the same frozen and live orders it always produces the
 * same output, and every live id appears exactly once.
 */

/**
 * The live order, re-sorted to the frozen one.
 *
 * Ids present in both keep their frozen relative order. Ids only in `live` are
 * new: each is placed just after the frozen row it followed in the live order
 * (or at the very top when it preceded all of them), preserving the live order
 * among themselves. Ids only in `frozen` are gone and simply drop out.
 */
export function mergeFrozenOrder(
  frozen: readonly string[],
  live: readonly string[]
): readonly string[] {
  if (frozen.length === 0) return live
  const rank = new Map<string, number>()
  for (let i = 0; i < frozen.length; i++) rank.set(frozen[i]!, i)

  const ranked: string[] = []
  // New ids, keyed by the ranked id they follow in the live order (`null` =
  // they come before every ranked row).
  const trailing = new Map<string | null, string[]>()
  let previous: string | null = null
  let sawNew = false
  for (const id of live) {
    if (rank.has(id)) {
      ranked.push(id)
      previous = id
    } else {
      sawNew = true
      const bucket = trailing.get(previous)
      if (bucket) bucket.push(id)
      else trailing.set(previous, [id])
    }
  }
  // Nothing to restore and nothing to slot in — hand back the live array so
  // the common case does not mint a new identity every emit.
  if (!sawNew && isSortedByRank(ranked, rank)) return live

  ranked.sort((a, b) => rank.get(a)! - rank.get(b)!)
  const out: string[] = []
  const head = trailing.get(null)
  if (head) out.push(...head)
  for (const id of ranked) {
    out.push(id)
    const tail = trailing.get(id)
    if (tail) out.push(...tail)
  }
  return out
}

function isSortedByRank(ids: readonly string[], rank: Map<string, number>): boolean {
  for (let i = 1; i < ids.length; i++) {
    if (rank.get(ids[i - 1]!)! > rank.get(ids[i]!)!) return false
  }
  return true
}

/**
 * How many conversations the freeze is holding back — the number the "N
 * updates" pill reports.
 *
 * Counts rows that the live order would move *earlier* than the frozen one
 * does: those are the ones something happened to. Counting every row whose
 * index differs would report "29 updates" for one chat jumping to the top of a
 * thirty-row list, which is true of the indices and false of the world.
 *
 * New rows are not counted: they are already on screen, un-frozen.
 */
export function frozenOrderPending(frozen: readonly string[], live: readonly string[]): number {
  if (frozen.length === 0) return 0
  const rank = new Map<string, number>()
  for (let i = 0; i < frozen.length; i++) rank.set(frozen[i]!, i)
  // Positions among the rows both orders know about, so a deletion elsewhere
  // does not read as movement.
  const shared: string[] = []
  for (const id of live) if (rank.has(id)) shared.push(id)
  const frozenShared = [...shared].sort((a, b) => rank.get(a)! - rank.get(b)!)
  const frozenIndex = new Map<string, number>()
  for (let i = 0; i < frozenShared.length; i++) frozenIndex.set(frozenShared[i]!, i)
  let moved = 0
  for (let i = 0; i < shared.length; i++) {
    if (i < frozenIndex.get(shared[i]!)!) moved += 1
  }
  return moved
}

// ---------------------------------------------------------------------------
// Section-level freeze
// ---------------------------------------------------------------------------

/**
 * The layout a reader was shown: which section each row was in, and in what
 * order.
 *
 * Freezing only the order *inside* each section would miss the worst symptom.
 * Under date bucketing the row you were reaching for does not merely slide —
 * a message arrives and it leaves "Yesterday" for "Today", so it is not where
 * you were looking at all. Membership is part of the order.
 */
export interface FrozenConversationLayout {
  sections: Array<{ section: ConversationSection; ids: readonly string[] }>
}

/** Snapshot the layout currently on screen. */
export function freezeConversationLayout(
  sections: readonly ConversationSection[]
): FrozenConversationLayout {
  return {
    sections: sections.map((section) => ({
      section,
      ids: section.sessions.map((s) => s.id),
    })),
  }
}

/**
 * Re-project the live sections onto a frozen layout.
 *
 * Each frozen section keeps its rows — with fresh row *data*, so titles,
 * previews and unread badges stay live while positions do not — in their frozen
 * order. Rows that arrived since are slotted in by {@link mergeFrozenOrder},
 * inside whichever section the live model puts them. Sections that only exist
 * in the live model are appended in their live order, so a brand-new bucket
 * still appears.
 *
 * A frozen section that has emptied out is dropped, except folders, which the
 * model always emits so their headers and empty states can render.
 */
export function projectFrozenSections(
  frozen: FrozenConversationLayout,
  live: readonly ConversationSection[]
): readonly ConversationSection[] {
  // Identity is preserved in the common case: this runs on every live-query
  // emit and feeds the render memos below it.
  if (frozen.sections.length === 0) return live

  // Fresh row data by id, and where the live model would put each row.
  const rowById = new Map<string, ChatSession>()
  const liveSectionOf = new Map<string, string>()
  for (const section of live) {
    const key = conversationSectionKey(section)
    for (const session of section.sessions) {
      rowById.set(session.id, session)
      liveSectionOf.set(session.id, key)
    }
  }
  const liveByKey = new Map(live.map((section) => [conversationSectionKey(section), section]))

  const frozenKeys = new Set(frozen.sections.map((entry) => conversationSectionKey(entry.section)))
  // New rows, grouped by the live section they belong to — only for sections
  // the freeze already knows about; a row in a genuinely new section rides
  // along with that section instead.
  const arrivalsByKey = new Map<string, string[]>()
  for (const section of live) {
    const key = conversationSectionKey(section)
    if (!frozenKeys.has(key)) continue
    for (const session of section.sessions) {
      if (frozenHas(frozen, session.id)) continue
      const bucket = arrivalsByKey.get(key)
      if (bucket) bucket.push(session.id)
      else arrivalsByKey.set(key, [session.id])
    }
  }

  const out: ConversationSection[] = []
  for (const entry of frozen.sections) {
    const key = conversationSectionKey(entry.section)
    const surviving = entry.ids.filter((id) => rowById.has(id))
    const arrivals = arrivalsByKey.get(key)
    // The live order restricted to this section's cast, so the slot-in has a
    // reference to place newcomers against — plus the frozen rows the live
    // model has since moved to *another* section. Those must still appear here
    // (that is the point of the freeze) and `mergeFrozenOrder` only emits ids
    // it is given; where they sit in this list is irrelevant, because it
    // re-sorts every known row by its frozen rank anyway.
    const cast = new Set(surviving)
    if (arrivals) for (const id of arrivals) cast.add(id)
    const liveOrder = (liveByKey.get(key)?.sessions ?? [])
      .map((s) => s.id)
      .filter((id) => cast.has(id))
    const elsewhere = surviving.filter((id) => !liveOrder.includes(id))
    const ids = arrivals?.length
      ? mergeFrozenOrder(surviving, [...liveOrder, ...elsewhere])
      : surviving
    const sessions = ids.map((id) => rowById.get(id)!).filter(Boolean)
    if (sessions.length === 0 && entry.section.kind !== "folder") continue
    // Carry the live section's own metadata (a folder rename, a collapse the
    // user just toggled) rather than the snapshot's.
    const base = liveByKey.get(key) ?? entry.section
    out.push({ ...base, sessions } as ConversationSection)
  }
  for (const section of live) {
    if (!frozenKeys.has(conversationSectionKey(section))) out.push(section)
  }
  return out
}

function frozenHas(frozen: FrozenConversationLayout, id: string): boolean {
  for (const entry of frozen.sections) if (entry.ids.includes(id)) return true
  return false
}

/** Rows the freeze is holding back, across every section. */
export function frozenLayoutPending(
  frozen: FrozenConversationLayout,
  live: readonly ConversationSection[]
): number {
  if (frozen.sections.length === 0) return 0
  const frozenSectionOf = new Map<string, string>()
  const frozenOrder: string[] = []
  for (const entry of frozen.sections) {
    const key = conversationSectionKey(entry.section)
    for (const id of entry.ids) {
      frozenSectionOf.set(id, key)
      frozenOrder.push(id)
    }
  }
  const liveOrder: string[] = []
  let migrated = 0
  for (const section of live) {
    const key = conversationSectionKey(section)
    for (const session of section.sessions) {
      liveOrder.push(session.id)
      const was = frozenSectionOf.get(session.id)
      // Changing section is the loudest kind of movement — the row is not
      // merely lower down, it is somewhere else entirely.
      if (was !== undefined && was !== key) migrated += 1
    }
  }
  return migrated + frozenOrderPending(frozenOrder, liveOrder)
}
