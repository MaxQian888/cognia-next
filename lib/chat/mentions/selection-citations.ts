/**
 * The citations a turn makes, derived from the references it actually sends.
 *
 * Citations used to be a second list the pick handler appended to as a side
 * effect (`recordMention`), kept beside the chips rather than read from them.
 * The two drifted in both directions: a reference staged from ⌘K went through
 * the staging hook alone and was never cited, and removing a chip left its
 * citation behind — so `metadata.mentions` claimed context the model never saw.
 * Reading the citations off the chips at send time makes both impossible.
 *
 * Only `entity` references cite: they are the records the backlink index knows
 * how to point back at. A combined reference (a transcript multi-select) cites
 * every member, so each message shows the backlink it earned.
 */

import type { ContextSelectionRef, EntitySelectionRef } from "@/types/artifact/artifact"
import type { ContextRef } from "./types"
import { mergeContextRefs } from "./merge-refs"

function entityCitation(
  entityKind: EntitySelectionRef["entityKind"],
  entityId: string,
  label: string
): ContextRef {
  return {
    kind: "entity",
    id: `${entityKind}:${entityId}`,
    label,
    raw: `@${entityKind}:${entityId}`,
  }
}

export function citationsForSelections(selections: readonly ContextSelectionRef[]): ContextRef[] {
  const refs = selections.flatMap((selection): ContextRef[] => {
    if (selection.kind !== "entity") return []
    if (selection.members && selection.members.length > 0) {
      return selection.members.map((member) =>
        entityCitation(selection.entityKind, member.entityId, member.title)
      )
    }
    return [entityCitation(selection.entityKind, selection.entityId, selection.title)]
  })
  // Deduplicated with the same identity `resolveMentions` uses, so a record
  // staged twice (or folded into two combined references) is cited once.
  return mergeContextRefs(refs, [])
}
