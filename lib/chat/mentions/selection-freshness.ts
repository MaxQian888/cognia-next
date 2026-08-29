/**
 * Are the staged context chips still describing what they claim to?
 *
 * A staged entity selection is a SNAPSHOT: the body is read once, when the user
 * picks it, and the chip carries that text until it is sent. That is the right
 * default — what the user read in the picker is what the model gets, and it is
 * the only version that can be shown on a chip synchronously — but it means the
 * source can move underneath it. Referencing a plan and then advancing three of
 * its steps before hitting send would quietly send the old plan.
 *
 * So the snapshot stays frozen and the DIVERGENCE is reported, on both sides:
 * the chip grows a badge and a refresh control, and the prompt block says when
 * the copy was taken. Silently re-reading at send time would be worse — the
 * user would have approved one body and sent another.
 */

import type { ContextSelectionRef, EntitySelectionRef } from "@/types/artifact/artifact"
import { isEntitySelectionStale } from "./entity-sources"

/** A selection with its freshness re-evaluated, or the original when unchanged. */
async function refreshOne(selection: ContextSelectionRef): Promise<ContextSelectionRef> {
  // Only entity selections have a source that can be asked. A file, web or
  // external excerpt was captured from a surface with no version to compare.
  if (selection.kind !== "entity") return selection
  const stale = await isEntitySelectionStale(selection)
  if (stale === Boolean(selection.stale)) return selection
  const next: EntitySelectionRef = { ...selection, stale }
  // `stale: false` is the default; storing it would make every unchanged chip
  // a new object and re-render the bar on every check.
  if (!stale) delete next.stale
  return next
}

export interface FreshnessPass {
  /** The list, with `stale` re-evaluated. Reference-equal when nothing moved. */
  selections: ContextSelectionRef[]
  /** True when at least one selection's staleness flipped. */
  changed: boolean
}

/**
 * Re-check every staged selection.
 *
 * Returns the SAME array reference when nothing changed, so a caller can use it
 * as a render guard without diffing. Failures resolve to the selection
 * unchanged rather than rejecting: a fingerprint read that throws must not lose
 * the user's staged context.
 */
export async function refreshSelectionFreshness(
  selections: readonly ContextSelectionRef[]
): Promise<FreshnessPass> {
  if (selections.length === 0) {
    return { selections: selections as ContextSelectionRef[], changed: false }
  }
  const next = await Promise.all(
    selections.map((selection) => refreshOne(selection).catch(() => selection))
  )
  const changed = next.some((selection, index) => selection !== selections[index])
  return {
    selections: changed ? next : (selections as ContextSelectionRef[]),
    changed,
  }
}
