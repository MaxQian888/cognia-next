/**
 * Date runs inside a group — "Today", "Yesterday", … under a squad in the
 * merged rail's scope tree (`BuildSectionsOptions.dateRunsInGroups`).
 *
 * A split group carries its rows twice over: `sessions`, every row in render
 * order, which is all most consumers need; and `dateRuns`, the same rows cut
 * by date. Anything that reorders, slices or re-projects a group's rows has to
 * keep the two in step, and anything that reorders rows has to do it *inside
 * one run*: a row's run is a fact about its timestamp, not a position a drag
 * or a held layout can move it out of. These helpers are the one place that
 * knows how, so the preview cap, the drop projection, the hover freeze and the
 * drag mapping cannot each grow their own idea of it.
 *
 * Pure; sections without runs pass through untouched.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import {
  conversationSectionKey,
  type ConversationDateSection,
  type ConversationGroupSection,
  type ConversationSection,
  type DateBucket,
} from "./conversation-list-model"

/** A block of rows that reorders as one: a whole section, or one of its runs. */
export interface ConversationReorderUnit {
  /** Section key a manual order made here is tagged with. */
  key: string
  sessions: readonly ChatSession[]
}

/**
 * The blocks a section's rows reorder in — one per date run for a split
 * group, the section itself otherwise.
 */
export function conversationReorderUnits(section: ConversationSection): ConversationReorderUnit[] {
  if (section.kind === "group" && section.dateRuns) {
    return section.dateRuns.map((run) => ({
      key: conversationSectionKey(run),
      sessions: run.sessions,
    }))
  }
  return [{ key: conversationSectionKey(section), sessions: section.sessions }]
}

/**
 * The section with the rows of the unit keyed `unitKey` replaced — the run
 * (and the group's flattened `sessions` with it) for a split group, the whole
 * section otherwise. `null` when the section holds no such unit.
 */
export function replaceReorderUnitSessions<S extends ConversationSection>(
  section: S,
  unitKey: string,
  sessions: ChatSession[]
): S | null {
  if (section.kind === "group" && section.dateRuns) {
    const index = section.dateRuns.findIndex((run) => conversationSectionKey(run) === unitKey)
    if (index === -1) return null
    const dateRuns = section.dateRuns.slice()
    dateRuns[index] = { ...dateRuns[index]!, sessions }
    return withDateRuns(section, dateRuns) as S
  }
  return conversationSectionKey(section) === unitKey ? { ...section, sessions } : null
}

/** A split group rebuilt from `dateRuns`, empty runs dropped. */
export function withDateRuns(
  section: ConversationGroupSection,
  dateRuns: readonly ConversationDateSection[]
): ConversationGroupSection {
  const kept = dateRuns.filter((run) => run.sessions.length > 0)
  return { ...section, dateRuns: kept, sessions: kept.flatMap((run) => run.sessions) }
}

/**
 * The first `limit` rows of a group, its runs cut at the same row — the
 * preview a "Show more" group draws.
 *
 * `keepId` names one row that must survive the cut wherever it sits — the
 * conversation open in the chat pane. It keeps its own place in the order (and
 * its own date run), so the preview reads as the head of the group plus the
 * one row the reader is in, never as a reordered list.
 */
export function sliceGroupRows(
  section: ConversationGroupSection,
  limit: number,
  keepId?: string | null
): ConversationGroupSection {
  const keepIndex = keepId ? section.sessions.findIndex((s) => s.id === keepId) : -1
  if (keepIndex >= limit) {
    const kept = new Set(section.sessions.slice(0, limit).map((s) => s.id))
    kept.add(keepId!)
    if (!section.dateRuns) {
      return { ...section, sessions: section.sessions.filter((s) => kept.has(s.id)) }
    }
    return withDateRuns(
      section,
      section.dateRuns.map((run) => ({
        ...run,
        sessions: run.sessions.filter((s) => kept.has(s.id)),
      }))
    )
  }
  if (!section.dateRuns) return { ...section, sessions: section.sessions.slice(0, limit) }
  const dateRuns: ConversationDateSection[] = []
  let left = limit
  for (const run of section.dateRuns) {
    if (left <= 0) break
    dateRuns.push(
      run.sessions.length <= left ? run : { ...run, sessions: run.sessions.slice(0, left) }
    )
    left -= run.sessions.length
  }
  return withDateRuns(section, dateRuns)
}

// ---------------------------------------------------------------------------
// Flat form, for the hover freeze
// ---------------------------------------------------------------------------

/**
 * Lift every split group's runs out to sit behind it as sections of their own
 * (a run's key is already distinct: `<group>/date:<bucket>`), leaving the
 * group as a row-less *host*. `lib/chat/conversation-order-freeze.ts` holds
 * section membership and order, so run over this form it holds a row in its
 * run exactly as it holds one in a top-level date bucket — a conversation
 * that picks up a message while the pointer is over the list stays under
 * "Yesterday" instead of jumping to "Today". A host keeps `dateRuns` as an
 * empty array, the mark {@link nestDateRuns} folds the runs back into.
 */
export function flattenDateRuns(
  sections: readonly ConversationSection[]
): readonly ConversationSection[] {
  if (!sections.some(isSplitGroup)) return sections
  const out: ConversationSection[] = []
  for (const section of sections) {
    if (!isSplitGroup(section)) {
      out.push(section)
      continue
    }
    out.push({ ...section, sessions: [], dateRuns: [] })
    out.push(...section.dateRuns)
  }
  return out
}

/** Whether a flattened section is a split group's row-less host. */
export function isDateRunHost(section: ConversationSection): boolean {
  return isSplitGroup(section) && section.dateRuns.length === 0 && section.sessions.length === 0
}

/**
 * Fold the runs of {@link flattenDateRuns}' output back into their hosts.
 *
 * Runs are gathered by `scope` wherever they sit — the freeze appends a run it
 * has not seen before at the very end of the list — and put in `bucketOrder`,
 * the order the list's headers run in. A host with no rows left is dropped
 * unless `preserveEmptyGroups`; a run whose host is gone is dropped with it.
 */
export function nestDateRuns(
  sections: readonly ConversationSection[],
  opts: { bucketOrder: readonly DateBucket[]; preserveEmptyGroups?: boolean }
): readonly ConversationSection[] {
  if (!sections.some((section) => isScopedRun(section) || isDateRunHost(section))) {
    return sections
  }
  const runsByScope = new Map<string, ConversationDateSection[]>()
  for (const section of sections) {
    if (!isScopedRun(section)) continue
    const runs = runsByScope.get(section.scope)
    if (runs) runs.push(section)
    else runsByScope.set(section.scope, [section])
  }
  const rank = new Map(opts.bucketOrder.map((bucket, index) => [bucket, index]))
  const out: ConversationSection[] = []
  for (const section of sections) {
    if (isScopedRun(section)) continue
    // Only a host is folded; anything else (including a group whose runs are
    // already nested) passes through.
    if (!isDateRunHost(section)) {
      out.push(section)
      continue
    }
    const host = section as ConversationGroupSection
    const runs = (runsByScope.get(conversationSectionKey(host)) ?? [])
      .slice()
      .sort((a, b) => (rank.get(a.bucket) ?? 0) - (rank.get(b.bucket) ?? 0))
    const nested = withDateRuns(host, runs)
    if (nested.sessions.length === 0 && !opts.preserveEmptyGroups) continue
    out.push(nested)
  }
  return out
}

function isSplitGroup(
  section: ConversationSection
): section is ConversationGroupSection & { dateRuns: ConversationDateSection[] } {
  return section.kind === "group" && section.dateRuns !== undefined
}

function isScopedRun(
  section: ConversationSection
): section is ConversationDateSection & { scope: string } {
  return section.kind === "date" && section.scope != null
}
