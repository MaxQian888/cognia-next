import type { ChatSession } from "@cognia/agent-config-types"

import {
  CONVERSATION_FILTER_UNASSIGNED,
  type ConversationFilterContext,
  type ConversationFilterListKey,
} from "@/lib/chat/conversation-filters"

/**
 * Candidate values for the multi-value filter facets, derived from the
 * conversations actually in the list.
 *
 * Offering every workspace / character the profile has ever created would make
 * the menu a directory rather than a filter: most rows would narrow the list to
 * nothing. So each option carries the number of conversations it would keep,
 * and options with zero matches are dropped — except values the *active*
 * filters already reference, which stay listed so they can be un-ticked.
 *
 * Pure: labels for models / providers are injected (they come from
 * `lib/ai/icons`, which this module deliberately does not import).
 */

export interface ConversationFilterOption {
  /** Facet value as stored in `ConversationFilters` (or the unassigned sentinel). */
  value: string
  /**
   * Display label. `null` for the unassigned sentinel — the surface substitutes
   * its own translated "No workspace" / "Not in a folder" / "No agent" copy.
   */
  label: string | null
  /** Conversations in the current view carrying this value. */
  count: number
}

export type ConversationFilterOptions = Readonly<
  Record<ConversationFilterListKey, readonly ConversationFilterOption[]>
>

export interface NamedEntity {
  id: string
  name: string
}

export interface BuildConversationFilterOptionsInput {
  /** Conversations in the current view (after the archive split, before filters). */
  sessions: readonly ChatSession[]
  workspaces?: readonly NamedEntity[]
  folders?: readonly NamedEntity[]
  agents?: readonly NamedEntity[]
  teams?: readonly NamedEntity[]
  /** Model / provider fallback chain — same object the matcher receives. */
  context?: Pick<ConversationFilterContext, "modelOf" | "providerOf">
  labelModel?: (id: string) => string
  labelProvider?: (id: string) => string
  /**
   * Values the active filters reference; kept in the option list even with a
   * zero count so the user can always see and remove what is narrowing the
   * list.
   */
  selected?: Partial<Record<ConversationFilterListKey, readonly string[]>>
}

const EMPTY_OPTIONS: readonly ConversationFilterOption[] = Object.freeze([])

export const EMPTY_CONVERSATION_FILTER_OPTIONS: ConversationFilterOptions = Object.freeze({
  workspaceIds: EMPTY_OPTIONS,
  folderIds: EMPTY_OPTIONS,
  agentIds: EMPTY_OPTIONS,
  teamIds: EMPTY_OPTIONS,
  models: EMPTY_OPTIONS,
  providers: EMPTY_OPTIONS,
})

function tally(sessions: readonly ChatSession[], pick: (s: ChatSession) => string | undefined) {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const key = pick(session) ?? CONVERSATION_FILTER_UNASSIGNED
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Entity-backed facet (workspace / folder / agent / team): options follow the
 * entity list's own display order, so the menu reads like the sidebar's group
 * headers; the unassigned row trails when relevant. Values referenced by the
 * session data but no longer backed by an entity (deleted workspace) are
 * listed by id so the filter never silently drops them.
 */
function entityOptions(
  counts: Map<string, number>,
  entities: readonly NamedEntity[] | undefined,
  selected: readonly string[] | undefined,
  allowUnassigned: boolean
): readonly ConversationFilterOption[] {
  const keep = new Set(selected ?? [])
  const out: ConversationFilterOption[] = []
  const seen = new Set<string>()
  for (const entity of entities ?? []) {
    if (seen.has(entity.id)) continue
    seen.add(entity.id)
    const count = counts.get(entity.id) ?? 0
    if (count > 0 || keep.has(entity.id)) out.push({ value: entity.id, label: entity.name, count })
  }
  for (const [value, count] of counts) {
    if (seen.has(value) || value === CONVERSATION_FILTER_UNASSIGNED) continue
    seen.add(value)
    out.push({ value, label: value, count })
  }
  for (const value of keep) {
    if (seen.has(value) || value === CONVERSATION_FILTER_UNASSIGNED) continue
    seen.add(value)
    out.push({ value, label: value, count: 0 })
  }
  if (allowUnassigned) {
    const unassigned = counts.get(CONVERSATION_FILTER_UNASSIGNED) ?? 0
    if (unassigned > 0 || keep.has(CONVERSATION_FILTER_UNASSIGNED)) {
      out.push({ value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: unassigned })
    }
  }
  return out.length ? out : EMPTY_OPTIONS
}

/**
 * Value-backed facet (model / provider): no entity list, so options are ordered
 * by how many conversations use them (ties by label) — the models you actually
 * talk to float up.
 */
function valueOptions(
  counts: Map<string, number>,
  selected: readonly string[] | undefined,
  label: (id: string) => string
): readonly ConversationFilterOption[] {
  const out: ConversationFilterOption[] = []
  for (const [value, count] of counts) {
    if (value === CONVERSATION_FILTER_UNASSIGNED) continue
    out.push({ value, label: label(value), count })
  }
  for (const value of selected ?? []) {
    if (counts.has(value)) continue
    out.push({ value, label: label(value), count: 0 })
  }
  out.sort((a, b) => b.count - a.count || (a.label ?? "").localeCompare(b.label ?? ""))
  return out.length ? out : EMPTY_OPTIONS
}

const identity = (id: string) => id

/** Build every facet's option list in one pass over the sessions. */
export function buildConversationFilterOptions(
  input: BuildConversationFilterOptionsInput
): ConversationFilterOptions {
  const {
    sessions,
    workspaces,
    folders,
    agents,
    teams,
    context,
    labelModel = identity,
    labelProvider = identity,
    selected,
  } = input
  if (sessions.length === 0 && !selected) return EMPTY_CONVERSATION_FILTER_OPTIONS
  return {
    workspaceIds: entityOptions(
      tally(sessions, (s) => s.projectId),
      workspaces,
      selected?.workspaceIds,
      true
    ),
    folderIds: entityOptions(
      tally(sessions, (s) => s.folderId ?? undefined),
      folders,
      selected?.folderIds,
      true
    ),
    agentIds: entityOptions(
      // Team conversations have no bound character; they must not swell the
      // "no agent" row, so they are excluded from this tally entirely.
      tally(
        sessions.filter((s) => s.kind !== "team"),
        (s) => s.characterId
      ),
      agents,
      selected?.agentIds,
      true
    ),
    teamIds: entityOptions(
      tally(
        sessions.filter((s) => s.teamId),
        (s) => s.teamId
      ),
      teams,
      selected?.teamIds,
      false
    ),
    models: valueOptions(
      tally(sessions, (s) => s.model ?? context?.modelOf?.(s)),
      selected?.models,
      labelModel
    ),
    providers: valueOptions(
      tally(sessions, (s) => s.providerOverride ?? context?.providerOf?.(s)),
      selected?.providers,
      labelProvider
    ),
  }
}

/** True when no facet has anything to offer (the menu hides those sections). */
export function hasConversationFilterOptions(
  options: ConversationFilterOptions,
  key: ConversationFilterListKey
): boolean {
  return options[key].length > 0
}
