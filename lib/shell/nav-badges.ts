/**
 * Live counts on the navigation's feature entries — the rail buttons, the
 * sidebar's hosted nav rows, the "More" menu and the OS app badge.
 *
 * Every count here already existed and was already live; nothing is counted a
 * second way. What was missing is a place that says which destination each
 * one belongs to, so the rail could say "Inbox has 3 things waiting" without
 * each surface subscribing to each source on its own:
 *
 *   inbox       ← pending connector drafts (`usePendingDrafts`, the same count
 *                 the Inbox's own sidebar badges its Drafts entry with), plus
 *                 connector HITL cards waiting in an IM conversation: tool
 *                 approvals (`pendingApprovalCount`) and `ask_user` questions
 *                 (`pendingAskUserCount`). All three are answered from an
 *                 Inbox conversation, which is why they badge Inbox.
 *   agent-runs  ← the Control Center's live attention items
 *                 (`useAttentionCount`): chat tool approvals, Squad HITL
 *                 gates, fleet sessions waiting on a permission, durable run
 *                 interrupts. Every one of them is a paused run, and
 *                 `/agent-runs` is where runs are.
 *   scheduler   ← tasks the scheduler page itself flags (`deriveAttention` in
 *                 `lib/scheduler/attention.ts`), counting only per-task
 *                 signals of `critical` / `attention` severity — a running
 *                 task is news, not something to act on.
 *   bots        ← Bots that need a person (`botRowNeedsAttention`).
 *
 * The sources are sampled once per window by `NavBadgeProbes`
 * (`components/shell/nav-badge-probes.tsx`), which writes into this module;
 * readers subscribe through `useNavBadges` (`hooks/shell/use-nav-badges.ts`).
 * That split is what keeps the always-mounted rail cheap: it re-renders when a
 * count changes, never because a Dexie query behind one re-ran.
 *
 * Pure module state + functions, no React, so tests drive it directly.
 */

/** A live count the probes report. Several can badge the same destination. */
export type NavBadgeSource =
  | "inbox.drafts"
  | "inbox.approvals"
  | "inbox.questions"
  | "agent-runs.attention"
  | "scheduler.attention"
  | "bots.attention"

/**
 * Which catalog item (`SIDEBAR_NAV_META` id) each source badges. The one table
 * to read when asking "why does Inbox show a 4".
 */
export const NAV_BADGE_TARGETS: Readonly<Record<NavBadgeSource, string>> = {
  "inbox.drafts": "inbox",
  "inbox.approvals": "inbox",
  "inbox.questions": "inbox",
  "agent-runs.attention": "agent-runs",
  "scheduler.attention": "scheduler",
  "bots.attention": "bots",
}

/** Catalog ids that can carry a badge at all. */
export const NAV_BADGE_ITEM_IDS: ReadonlySet<string> = new Set(Object.values(NAV_BADGE_TARGETS))

/** Catalog id → count. Ids with nothing waiting are absent. */
export type NavBadgeCounts = Readonly<Record<string, number>>

const EMPTY_COUNTS: NavBadgeCounts = Object.freeze({})

const sourceCounts = new Map<NavBadgeSource, number>()
let snapshot: NavBadgeCounts = EMPTY_COUNTS
const listeners = new Set<() => void>()

/** Fold the per-source counts into the per-destination snapshot. */
function rebuildSnapshot(): NavBadgeCounts {
  const next: Record<string, number> = {}
  for (const [source, count] of sourceCounts) {
    if (count <= 0) continue
    const target = NAV_BADGE_TARGETS[source]
    next[target] = (next[target] ?? 0) + count
  }
  return Object.keys(next).length === 0 ? EMPTY_COUNTS : Object.freeze(next)
}

function sameCounts(a: NavBadgeCounts, b: NavBadgeCounts): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/**
 * Report `source`'s current count. Negative and non-finite counts are treated
 * as zero. Listeners hear about it only when a destination's total actually
 * changed, and the snapshot object is replaced only then — which is what lets
 * `useSyncExternalStore` readers skip the re-render.
 */
export function setNavBadgeSourceCount(source: NavBadgeSource, count: number): void {
  const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if ((sourceCounts.get(source) ?? 0) === normalized) return
  if (normalized === 0) sourceCounts.delete(source)
  else sourceCounts.set(source, normalized)
  const next = rebuildSnapshot()
  if (sameCounts(next, snapshot)) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore` subscribe. */
export function subscribeNavBadges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** `useSyncExternalStore` snapshot — stable until a destination's count changes. */
export function getNavBadgeSnapshot(): NavBadgeCounts {
  return snapshot
}

/** Server snapshot: nothing is waiting in a static export. */
export function getNavBadgeServerSnapshot(): NavBadgeCounts {
  return EMPTY_COUNTS
}

/** The count to draw for catalog item `id`, `0` when there is none. */
export function navBadgeCount(counts: NavBadgeCounts, id: string): number {
  return counts[id] ?? 0
}

/**
 * Sum the badges of `ids` — the items that are actually on screen. A hidden
 * item's count is left out: the user took it off the navigation, and a badge
 * or a dock number pointing at a place they cannot see is a promise the
 * navigation cannot keep.
 */
export function sumNavBadges(counts: NavBadgeCounts, ids: Iterable<string>): number {
  let total = 0
  for (const id of ids) total += counts[id] ?? 0
  return total
}

/** Test-only: forget every reported count and listener. */
export function __resetNavBadgesForTests(): void {
  sourceCounts.clear()
  snapshot = EMPTY_COUNTS
  listeners.clear()
}
