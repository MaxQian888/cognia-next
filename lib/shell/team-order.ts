/**
 * The user's own order for the team list — the sidebar's guild accordion
 * (`components/shell/sidebar-guild-sections.tsx`) and the icon rail that
 * mirrors it (`components/shell/guild-rail.tsx`) both read it, so a team
 * dragged in one shows up in the same slot in the other.
 *
 * Stored as `conversationSidebar.teamOrder` — a list of ids, not a field on
 * the `Team` row: the order is a preference of *this* profile's sidebar, and
 * writing it onto the team would move it for every surface that reads teams
 * (the composer's team picker, the settings table) and, once teams sync,
 * for everyone in them.
 *
 * The stored list is always treated as a hint rather than as the truth: it can
 * name teams that were since deleted and can be missing teams created after
 * the last drag. `orderTeams` resolves both without ever dropping or
 * duplicating a row, which is what lets the writer stay a plain "here is the
 * new order" without a migration whenever the team set changes.
 */

/** The subset of `Team` this module needs — keeps it usable from tests. */
export interface OrderableTeam {
  id: string
}

/**
 * Apply a stored order to the teams that actually exist.
 *
 * Listed ids come first, in the stored order; every team the order does not
 * mention keeps its incoming relative position and lands after them (the DB
 * read is `orderBy("name")`, so that tail stays alphabetical). Ids naming a
 * team that no longer exists are skipped rather than leaving a hole.
 */
export function orderTeams<T extends OrderableTeam>(
  teams: readonly T[],
  order: readonly string[] | undefined
): T[] {
  if (!order || order.length === 0) return [...teams]
  const byId = new Map(teams.map((team) => [team.id, team]))
  const ranked: T[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const team = byId.get(id)
    // `seen` guards a stored list that names the same id twice — a row must
    // never be rendered under two keys.
    if (!team || seen.has(id)) continue
    seen.add(id)
    ranked.push(team)
  }
  for (const team of teams) {
    if (!seen.has(team.id)) ranked.push(team)
  }
  return ranked
}

/**
 * The order to persist after a drag or a "move up/down": the ids exactly as
 * they are now rendered. Written whole rather than as a patch so a team that
 * had never been dragged is pinned in place by the same write that moved its
 * neighbour — otherwise it would drift back into the alphabetical tail.
 */
export function teamOrderFrom(teams: readonly OrderableTeam[]): string[] {
  return teams.map((team) => team.id)
}

/**
 * Move one team by `delta` slots within `ids`, or `null` when the move has
 * nowhere to go (unknown id, already at the end it is being pushed toward).
 * This is the keyboard path for the same reorder the drag performs — the
 * team rows' context menu offers it, because the rows' Enter/Space already
 * mean "open this section" and cannot also mean "pick this up".
 */
export function moveTeamInOrder(
  ids: readonly string[],
  id: string,
  delta: number
): string[] | null {
  const from = ids.indexOf(id)
  if (from < 0) return null
  const to = from + delta
  if (to < 0 || to >= ids.length) return null
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}
