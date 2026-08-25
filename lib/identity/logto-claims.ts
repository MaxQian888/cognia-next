/**
 * Reading identity out of a Logto session — ADR-0149.
 *
 * # This proves nothing
 *
 * Everything here is UNVERIFIED extraction from a base64url payload. The
 * signature check lives where the token is consumed:
 * `src-tauri/src/companion_api/oidc.rs` validates `iss`, `aud`, `exp` and the
 * required scopes against the JWKS before anything is authorized. The renderer
 * reads the same claims only to answer "who am I and which org am I in" for the
 * UI and for the local binding. A caller that treats these values as an
 * authorization decision has introduced a bug.
 *
 * # Why the merge rule is copied byte for byte
 *
 * `oidc.rs` builds its group set as `groups ∪ organization_roles`, dropping
 * blanks, through a `BTreeSet` — so deduped and sorted. `groupIds` here
 * reproduces that exactly, because a renderer that disagrees with the host
 * about someone's groups is precisely the drift this codebase keeps growing.
 * `organizationRoles` is kept raw and separate, and it is what the Org role is
 * derived from: the merged set also contains plain Logto *groups*, and a group
 * that happens to be named "admin" must not promote anybody.
 */

import { decodeJwtPayload, stringClaim, stringListClaim } from "@/lib/security/jwt-payload"
import type { OrgRole } from "@/types/identity"

import type { LogtoSession } from "@/lib/logto/client"

export interface LogtoAccessClaims {
  /** `sub` — the Logto user id (a human) or M2M application id (a service). */
  subject: string
  /** `organization_id` — absent on a non-organization token. */
  organizationId?: string
  /** `groups ∪ organization_roles`, blanks dropped, deduped, sorted. */
  groupIds: string[]
  /** `organization_roles` verbatim — the only input to the Org role. */
  organizationRoles: string[]
  scopes: string[]
  /** `exp`, converted from OIDC seconds to the epoch milliseconds we use. */
  expiresAt?: number
}

export interface LogtoProfileClaims {
  name?: string
  email?: string
  picture?: string
}

/** Mirror of `oidc.rs`'s `group_ids`: merge, drop blanks, dedupe, sort. */
export function mergeGroupIds(groups: string[], organizationRoles: string[]): string[] {
  const merged = new Set<string>()
  for (const value of [...groups, ...organizationRoles]) {
    if (value.trim().length > 0) merged.add(value)
  }
  return [...merged].sort()
}

/** Read the access token's identity claims, or `null` if it is unreadable. */
export function readLogtoAccessClaims(accessToken: string): LogtoAccessClaims | null {
  const payload = decodeJwtPayload(accessToken)
  const subject = stringClaim(payload, "sub")
  if (!payload || !subject) return null

  const organizationRoles = stringListClaim(payload, "organization_roles")
  const exp = payload.exp

  return {
    subject,
    organizationId: stringClaim(payload, "organization_id"),
    groupIds: mergeGroupIds(stringListClaim(payload, "groups"), organizationRoles),
    organizationRoles,
    scopes: stringListClaim(payload, "scope"),
    expiresAt: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined,
  }
}

/**
 * Read the display half from the ID token. Absent claims stay absent rather
 * than becoming empty strings, so a caller can tell "Logto did not assert a
 * name" from "Logto asserted an empty one".
 */
export function readLogtoProfileClaims(idToken: string | undefined): LogtoProfileClaims {
  const payload = idToken ? decodeJwtPayload(idToken) : null
  return {
    name: stringClaim(payload, "name") ?? stringClaim(payload, "username"),
    email: stringClaim(payload, "email"),
    picture: stringClaim(payload, "picture"),
  }
}

/**
 * Map Logto organization roles onto this product's Org role.
 *
 * Logto role ids are free text configured by whoever set the tenant up, so the
 * mapping is a convention, stated here and nowhere else: a role id equal to
 * `owner` or `admin` (case-insensitively) means that; everything else is a
 * plain member. Fail-quiet is correct in this direction — an unrecognised role
 * under-grants, and the server re-decides anyway once Batch 3 lands.
 */
export function orgRoleFromOrganizationRoles(organizationRoles: string[]): OrgRole {
  const normalized = organizationRoles.map((role) => role.trim().toLowerCase())
  if (normalized.includes("owner")) return "owner"
  if (normalized.includes("admin")) return "admin"
  return "member"
}

export interface LogtoIdentity {
  access: LogtoAccessClaims
  profile: LogtoProfileClaims
  orgRole: OrgRole
}

/**
 * Everything the binding step needs from one session, or `null` when the access
 * token carries no readable subject — which is the only case where there is no
 * person to bind to.
 */
export function readLogtoIdentity(session: LogtoSession): LogtoIdentity | null {
  const access = readLogtoAccessClaims(session.accessToken)
  if (!access) return null
  return {
    access,
    profile: readLogtoProfileClaims(session.idToken),
    orgRole: orgRoleFromOrganizationRoles(access.organizationRoles),
  }
}
