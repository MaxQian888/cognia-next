/**
 * Second-level grouping for the conversation filter menu.
 *
 * The menu grew one top-level row per facet, and by the time workspace, folder,
 * agent, team, provider and model all had candidates it was seven rows plus
 * saved views. Seven rows of the same weight is not a menu, it is a list to
 * read, and the two questions people actually arrive with (narrow it down /
 * where does it live) were spread across it in no particular order.
 *
 * So the sections are folded into families, and the fold is described here as
 * data rather than in the two renderers. Both the desktop dropdown and the
 * mobile drawer draw the same entries, which is what stops the two surfaces
 * from disagreeing about what is nested under what.
 *
 * Two rules keep the fold from ever being worse than the flat list it replaced.
 * A family whose sections are all absent disappears rather than opening onto
 * nothing, and a family with exactly one present section collapses into that
 * section at the top level rather than charging a click to reach it. On an
 * install with no teams and one provider, the menu is as shallow as it was.
 */

/** The families, in the order they are offered. */
export const CONVERSATION_FACET_FAMILIES = ["refine", "scope"] as const

export type ConversationFacetFamilyKey = (typeof CONVERSATION_FACET_FAMILIES)[number]

/**
 * Which family each section belongs to. A section that names no family stays a
 * top-level entry: `sort` is one radio group and nesting it would cost a click
 * to reach the single most-used control in the menu.
 */
export const CONVERSATION_FACET_FAMILY_OF: Record<string, ConversationFacetFamilyKey | undefined> =
  {
    sort: undefined,
    status: "refine",
    activity: "refine",
    location: "scope",
    agent: "scope",
    model: "scope",
  }

/** The minimum a section has to expose for the fold to be computable. */
export interface FacetSectionLike {
  key: string
  activeCount: number
}

export type FacetMenuEntry<S extends FacetSectionLike> =
  | { kind: "section"; key: string; section: S }
  | {
      kind: "family"
      key: ConversationFacetFamilyKey
      sections: S[]
      /** Sum of the nested sections' own counts, so the fold hides no state. */
      activeCount: number
    }

/**
 * Fold `sections` into the menu's two levels, preserving the order the caller
 * built them in. Unknown section keys are passed through at the top level, so a
 * facet added without a family entry is visible rather than silently dropped.
 */
export function groupFacetSections<S extends FacetSectionLike>(
  sections: readonly S[]
): FacetMenuEntry<S>[] {
  const families = new Map<ConversationFacetFamilyKey, S[]>()
  const entries: FacetMenuEntry<S>[] = []
  // A placeholder keeps the family's position at the point its first section
  // appeared, so folding never reorders what the user was already reading.
  const placeholders = new Map<ConversationFacetFamilyKey, number>()

  for (const section of sections) {
    const family = CONVERSATION_FACET_FAMILY_OF[section.key]
    if (!family) {
      entries.push({ kind: "section", key: section.key, section })
      continue
    }
    const bucket = families.get(family)
    if (bucket) {
      bucket.push(section)
      continue
    }
    families.set(family, [section])
    placeholders.set(family, entries.length)
    entries.push({ kind: "family", key: family, sections: [], activeCount: 0 })
  }

  for (const [family, bucket] of families) {
    const at = placeholders.get(family)
    if (at === undefined) continue
    if (bucket.length === 1) {
      const only = bucket[0]
      if (only) entries[at] = { kind: "section", key: only.key, section: only }
      continue
    }
    entries[at] = {
      kind: "family",
      key: family,
      sections: bucket,
      activeCount: bucket.reduce((total, section) => total + section.activeCount, 0),
    }
  }

  return entries
}

/**
 * Which top-level entries a fresh menu opens with. The two the user came for
 * more often than not, and never a facet list whose contents are install
 * specific and can run to dozens of rows.
 *
 * Matched on the family an entry BELONGS to, not on the key it ended up with:
 * a `refine` holding one present section collapses to that section at the top
 * level (`groupFacetSections`), and keying off `"refine"` alone would then open
 * the drawer on sort and nothing else.
 */
export function defaultOpenFacetEntries<S extends FacetSectionLike>(
  entries: readonly FacetMenuEntry<S>[]
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.key === "sort" ||
        (entry.kind === "family" ? entry.key : CONVERSATION_FACET_FAMILY_OF[entry.key]) === "refine"
    )
    .map((entry) => entry.key)
}
