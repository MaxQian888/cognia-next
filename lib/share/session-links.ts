/**
 * The share links a conversation was shared through, for its delete
 * (ADR-0222 §10).
 *
 * A snapshot share is an independent encrypted copy: deleting the
 * conversation leaves it working, and My Shares then reads "from a deleted
 * conversation". The delete confirms offer to revoke them in the same step,
 * which this module answers: the links made on this device from these
 * conversations that still work, and revoking them.
 */

import { listSharedLinks, type SharedLinkRow } from "@/lib/db/shared-links"
import { revokeShareLink } from "@/lib/share/client"

/** Links made from any of `sessionIds` that are neither revoked nor expired. */
export async function listLiveShareLinksForSessions(
  sessionIds: readonly string[],
  now: number = Date.now()
): Promise<SharedLinkRow[]> {
  if (sessionIds.length === 0) return []
  const wanted = new Set(sessionIds)
  const rows = await listSharedLinks()
  return rows.filter(
    (row) =>
      row.sessionId !== undefined &&
      wanted.has(row.sessionId) &&
      (row.expiresAt === undefined || row.expiresAt > now)
  )
}

export interface RevokeSessionLinksResult {
  revoked: number
  failed: number
}

/**
 * Revoke every live link made from `sessionIds`. Each link is revoked on its
 * own: one the server refuses (offline, another endpoint) is counted, and
 * the rest still go.
 */
export async function revokeShareLinksForSessions(
  sessionIds: readonly string[],
  revoke: (code: string) => Promise<void> = (code) => revokeShareLink(code)
): Promise<RevokeSessionLinksResult> {
  const links = await listLiveShareLinksForSessions(sessionIds)
  const outcomes = await Promise.allSettled(links.map((link) => revoke(link.code)))
  const failed = outcomes.filter((outcome) => outcome.status === "rejected").length
  return { revoked: outcomes.length - failed, failed }
}
