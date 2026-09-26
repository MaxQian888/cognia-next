/**
 * Muted teams — the navigation's "stop telling me about this one".
 *
 * A mute is a display choice about the guild badges, not about the
 * conversations: the per-row unread state inside a muted team is untouched,
 * and opening the team still shows which rows are unread. What goes quiet is
 * everything that *summarizes* the team from outside it — the rail button's
 * count, the compact guild band's pill, the app/dock badge.
 *
 * Stored as `conversationSidebar.mutedTeamIds` next to `teamOrder`, for the
 * same reason (a preference of this profile's sidebar, not shared team data).
 *
 * The filter is applied to the aggregate `useGuildUnread` returns
 * (`hooks/shell/use-guild-unread.ts`) rather than inside it, so the aggregate
 * stays one honest count of what is unread and each reader decides what it
 * shows. `useVisibleGuildUnread` (`hooks/shell/use-team-mute.ts`) is that
 * reader for the rail, the band and the app badge. Pure, so tests drive it
 * directly.
 */

/** The shape of `GuildUnread` this module reads and returns. */
export interface GuildUnreadCounts {
  dm: number
  teams: ReadonlyMap<string, number>
  total: number
}

const NO_MUTED: ReadonlySet<string> = new Set()

/** The stored list as a set; absent or empty means nothing is muted. */
export function mutedTeamSet(stored: readonly string[] | undefined): ReadonlySet<string> {
  return stored && stored.length > 0 ? new Set(stored) : NO_MUTED
}

/**
 * `unread` without the muted teams: their entries leave `teams` and their
 * counts leave `total`. Returns the input object itself when nothing it
 * counts is muted, so a memoized reader does not re-render for a no-op.
 */
export function applyGuildMute<T extends GuildUnreadCounts>(
  unread: T,
  muted: ReadonlySet<string>
): T {
  if (muted.size === 0) return unread
  let removed = 0
  const teams = new Map<string, number>()
  for (const [teamId, count] of unread.teams) {
    if (muted.has(teamId)) removed += count
    else teams.set(teamId, count)
  }
  if (removed === 0 && teams.size === unread.teams.size) return unread
  return { ...unread, teams, total: unread.total - removed }
}

/** The stored list after muting (`true`) or unmuting (`false`) `teamId`. */
export function withTeamMuted(
  stored: readonly string[] | undefined,
  teamId: string,
  muted: boolean
): string[] {
  const current = stored ?? []
  if (muted) return current.includes(teamId) ? [...current] : [...current, teamId]
  return current.filter((id) => id !== teamId)
}
