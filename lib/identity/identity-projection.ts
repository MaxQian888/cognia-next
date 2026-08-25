/**
 * Writing a signed-in identity into the local projection (ADR-0149).
 *
 * This is the concrete half of `IdentityProjectionWriter`, the seam
 * `bindSignedInIdentity` writes through. It lives here rather than inside
 * sign-in because ADR-0149 §6 makes the collaboration server authoritative for
 * these rows: the writer is a cache-fill, and keeping it behind the seam is
 * what lets Batch 3 replace it with "ask the server, then mirror the answer"
 * without touching the sign-in flow.
 *
 * The Org membership written here is derived from the token's
 * `organization_roles` and is therefore a GUESS at what the server will say —
 * good enough to render a badge, never good enough to authorize anything. When
 * the server arrives it overwrites this row; the row's shape does not change.
 */

import { linkExternalIdentity, putOrgMembership, upsertOrg, upsertUser } from "@/lib/db/identity"

import type { IdentityProjectionWriter, SignedInIdentity } from "./sign-in"

/**
 * Mirror one signed-in identity into `users` / `orgs` / `orgMemberships` /
 * `externalIdentities`.
 *
 * Sequenced rather than parallel: the membership row names a user and an org,
 * and a reader that arrives between two parallel writes would see a membership
 * pointing at rows that are not there yet.
 */
export async function writeIdentityProjection(identity: SignedInIdentity): Promise<void> {
  const { user, org, orgRole, binding } = identity

  await upsertUser(user)

  if (org) {
    await upsertOrg(org)
    if (orgRole) {
      await putOrgMembership({
        orgId: org.id,
        userId: user.id,
        role: orgRole,
        now: binding.updatedAt,
      })
    }
  }

  await linkExternalIdentity({
    userId: user.id,
    provider: "logto",
    subject: binding.logtoSubject,
    // The issuer identifies the Logto deployment, which is the tenant boundary
    // for a subject: two deployments can mint the same `sub` for two people.
    tenant: binding.logtoIssuer,
    ...(user.displayName ? { label: user.displayName } : {}),
    now: binding.updatedAt,
  })
}

export const identityProjection: IdentityProjectionWriter = {
  upsert: writeIdentityProjection,
}
