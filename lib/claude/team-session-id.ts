/**
 * Team sub-session id codec.
 *
 * A team turn drives each member through the sidecar under a distinct
 * sub-session id derived from the team ChatSession id. The chat store, the
 * desktop/mobile shells, and `useTeamChat` all partition the event stream and
 * approval routing on this shape, so the codec lives here (pure, no React)
 * rather than inside the hook.
 */

export const SUB_SEPARATOR = "::char::"

/**
 * Build a sub-session id from the team session and character. A turnId suffix
 * keeps successive turns (e.g. regenerates) from colliding with stale resolver
 * entries inside the in-flight orchestrator loop.
 */
export function subSessionId(teamSessionId: string, characterId: string, turnId: string): string {
  return `${teamSessionId}${SUB_SEPARATOR}${characterId}::${turnId}`
}

/**
 * Decode a sub-session id into its team-session + character pair, or null if
 * the id isn't a team sub-session. The optional `::turnId` suffix is stripped.
 */
export function decodeSubSession(
  id: string
): { teamSessionId: string; characterId: string } | null {
  const idx = id.indexOf(SUB_SEPARATOR)
  if (idx < 0) return null
  const tail = id.slice(idx + SUB_SEPARATOR.length)
  const sep = tail.indexOf("::")
  return {
    teamSessionId: id.slice(0, idx),
    characterId: sep < 0 ? tail : tail.slice(0, sep),
  }
}

/** True when `id` is a team sub-session id (`…::char::…`). */
export function isSubSessionId(id: string): boolean {
  return id.includes(SUB_SEPARATOR)
}
