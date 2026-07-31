/**
 * Format the one-line "active skills" notice the chat shows when a turn loads
 * session-enabled skills (carried in the `/skill` state file). Pure + tested so
 * the wording is verified without driving a live turn.
 */

/**
 * Human-meaningful display name for a skill id. Canonical ids look like
 * `cli-disk:project:my-skill` or `builtin:web-search`; the last colon-segment
 * is the slug the user recognises, so we surface that. Ids without a colon are
 * shown verbatim.
 */
export function displaySkillName(id: string): string {
  const trimmed = id.trim()
  const seg = trimmed.split(":").pop()
  return seg && seg.length > 0 ? seg : trimmed
}

/**
 * One-line notice listing the skills active for this chat session, e.g.
 * `Active skills (2): web-search, my-skill`. Returns `null` when no skills are
 * active, so callers can skip dispatching an empty notice.
 */
export function formatActiveSkillsNotice(skillIds: readonly string[]): string | null {
  const names = skillIds.map(displaySkillName).filter((n) => n.length > 0)
  if (names.length === 0) return null
  return `Active skills (${names.length}): ${names.join(", ")}`
}
