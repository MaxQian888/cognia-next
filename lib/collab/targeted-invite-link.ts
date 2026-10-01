/**
 * The link a `chat.invited` notification carries (ADR-0207): an invite
 * addressed to one person, accepted by id rather than by token.
 *
 * Conversations render at the root route (`app/page.tsx` picks the desktop or
 * phone shell; there is no `/chat` page in the static export), so the link is
 * `/?acceptInvite=<inviteId>&org=<orgId>` and the root page is what consumes
 * it. The org travels with the id because an invite id means nothing outside
 * the org that issued it, and accepting under another org would be refused.
 */

export const ACCEPT_INVITE_PARAM = "acceptInvite"
export const INVITE_ORG_PARAM = "org"
/** The route that renders conversations, and so the route that consumes the link. */
export const TARGETED_INVITE_ROUTE = "/"

export interface TargetedInviteLink {
  inviteId: string
  orgId: string
}

/** Both halves present and non-blank, or no link at all. */
export function readTargetedInviteLink(
  params: Pick<URLSearchParams, "get"> | null | undefined
): TargetedInviteLink | null {
  const inviteId = params?.get(ACCEPT_INVITE_PARAM)?.trim() ?? ""
  const orgId = params?.get(INVITE_ORG_PARAM)?.trim() ?? ""
  return inviteId && orgId ? { inviteId, orgId } : null
}

export function targetedInviteHref(link: TargetedInviteLink): string {
  const query = new URLSearchParams({
    [ACCEPT_INVITE_PARAM]: link.inviteId,
    [INVITE_ORG_PARAM]: link.orgId,
  })
  return `${TARGETED_INVITE_ROUTE}?${query.toString()}`
}

/**
 * The current location with the link's two params removed and every other
 * param kept, so consuming an invite cannot also swallow, say, a message
 * permalink that arrived in the same URL.
 */
export function withoutTargetedInviteParams(
  pathname: string,
  params: Pick<URLSearchParams, "toString"> | null | undefined
): string {
  const rest = new URLSearchParams(params?.toString() ?? "")
  rest.delete(ACCEPT_INVITE_PARAM)
  rest.delete(INVITE_ORG_PARAM)
  const query = rest.toString()
  return query ? `${pathname}?${query}` : pathname
}
