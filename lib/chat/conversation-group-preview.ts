/**
 * "Show more" previews for the scope tree.
 *
 * The merged rail renders every scope at once — Chats plus one collapsible
 * group per squad — so an uncapped team could push every sibling off screen.
 * Each group opens capped; the expander is a transient disclosure, not a
 * standing answer to "how tall should this group be", so it lives in the
 * surface's local state rather than the persisted collapse map.
 *
 * Kept pure and section-shaped so the list's ordered ids, drop targets and
 * reveal ladder all read the same capped truth the paint does.
 */

import {
  conversationSectionKey,
  UNGROUPED_ID,
  type ConversationSection,
} from "./conversation-list-model"

/**
 * Rows a group shows before its "Show more" row. Small on purpose — the
 * tree's job is breadth (every scope visible at a glance), depth is one click
 * away. Squads cap tighter than Chats: the open scope's conversations are the
 * ones the rail exists to reach, so its preview runs longer; a squad's two
 * most recent threads are usually enough context under its header.
 */
export const CHATS_GROUP_PREVIEW_LIMIT = 4
export const SQUAD_GROUP_PREVIEW_LIMIT = 2

/**
 * The tail so small it is not worth a row of its own: "Show 1 more" costs a
 * click to reveal less than a row's worth of content, so groups this close to
 * the limit just show everything.
 */
const PREVIEW_TAIL_TOLERANCE = 2

function previewLimit(section: ConversationSection): number {
  return isChatsScopeGroup(section) ? CHATS_GROUP_PREVIEW_LIMIT : SQUAD_GROUP_PREVIEW_LIMIT
}

/**
 * Slice every team-axis group to its preview length and annotate the cut.
 *
 * Sections the cap does not touch — other axes, search, pinned, folders —
 * pass through with their identity intact, so callers can memo on the array
 * and only the capped groups churn. `expanded` holds the section keys
 * (`team:<id>`) whose caps the user lifted this session.
 */
export function applyTeamGroupPreviewCaps(
  sections: readonly ConversationSection[],
  expanded: ReadonlySet<string>
): ConversationSection[] {
  return sections.map((section) => {
    if (section.kind !== "group" || section.axis !== "team") return section
    if (expanded.has(conversationSectionKey(section))) return section
    const limit = previewLimit(section)
    const hidden = section.sessions.length - limit
    // A remainder of one or two rows buys nothing — show the tail rather than
    // an expander row nearly as tall as what it hides.
    if (hidden <= PREVIEW_TAIL_TOLERANCE) return section
    return {
      ...section,
      sessions: section.sessions.slice(0, limit),
      previewHidden: hidden,
    }
  })
}

/**
 * Whether the "Show less" affordance applies — the cap was lifted AND the
 * group is long enough that collapsing it back saves real space.
 */
export function teamGroupPreviewExpanded(
  section: Extract<ConversationSection, { kind: "group" }>,
  expanded: ReadonlySet<string>
): boolean {
  return (
    section.sessions.length > previewLimit(section) + PREVIEW_TAIL_TOLERANCE &&
    expanded.has(conversationSectionKey(section))
  )
}

/** The ungrouped bucket on the team axis is the "Chats" scope group. */
export function isChatsScopeGroup(section: ConversationSection): boolean {
  return section.kind === "group" && section.axis === "team" && section.group.id === UNGROUPED_ID
}
