/**
 * The Suggested ordering of Files (ADR-0223): a local score, no model call.
 *
 * Three signals, each bounded so none drowns the others:
 * - recency — `exp(-age / 14 days)` of the newest open or change, so an item
 *   touched today scores ~1 and one untouched for a month ~0.1;
 * - reach — `0.35 · log2(1 + conversations)`, so an item reused across
 *   several conversations climbs without one heavily reused file pinning the
 *   top for good;
 * - intent — `+0.5` for a favorite, `+0.25` for an item opened (from Files or
 *   its own surface) in the last week: an explicit look, not just a background
 *   change.
 */

import { entryRecency } from "./aggregate"
import type { FilesEntry } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000
export const SUGGESTION_RECENCY_HALF_SCALE_DAYS = 14
export const SUGGESTION_REACH_WEIGHT = 0.35
export const SUGGESTION_FAVORITE_BONUS = 0.5
export const SUGGESTION_RECENT_OPEN_BONUS = 0.25
export const SUGGESTION_RECENT_OPEN_WINDOW_MS = 7 * DAY_MS

export function suggestionScore(
  entry: Pick<FilesEntry, "lastAccessedAt" | "updatedAt" | "sessionIds" | "favoritedAt">,
  now: number
): number {
  const ageDays = Math.max(0, now - entryRecency(entry)) / DAY_MS
  const recency = Math.exp(-ageDays / SUGGESTION_RECENCY_HALF_SCALE_DAYS)
  const reach = SUGGESTION_REACH_WEIGHT * Math.log2(1 + entry.sessionIds.length)
  const favorite = entry.favoritedAt !== undefined ? SUGGESTION_FAVORITE_BONUS : 0
  const openedRecently =
    entry.lastAccessedAt !== undefined &&
    now - entry.lastAccessedAt <= SUGGESTION_RECENT_OPEN_WINDOW_MS
      ? SUGGESTION_RECENT_OPEN_BONUS
      : 0
  return recency + reach + favorite + openedRecently
}
