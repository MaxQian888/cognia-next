/**
 * Turning a Logto session into a person this machine knows — ADR-0149.
 *
 * # Where the `usr_…` comes from
 *
 * ADR-0149 §3 is emphatic that `User.id` is ours and the subject is theirs:
 * nothing joins on a Logto `sub`, so swapping the IdP later is a re-link in one
 * table rather than a migration through every table.
 *
 * That leaves the question of what the id IS on the very first sign-in, before
 * Batch 3's collaboration server exists to assign one. Minting a random id would
 * make two machines invent two different people for the same human, and Batch 3
 * would inherit the mess. So the FIRST value is derived — `usr_` plus a slice of
 * SHA-256 over issuer and subject — which makes every machine agree without a
 * server to ask.
 *
 * The derivation is a minting strategy, not a rule. Once written, the id is an
 * opaque key like any other: nothing re-derives it, nothing compares a stored id
 * against a fresh derivation, and re-linking the same person to a different IdP
 * keeps the id they already have. The property ADR-0149 wanted survives — the id
 * merely happened to be derived once.
 *
 * # What signing in does NOT do
 *
 * It does not unlock, gate or touch the profile's data. A LocalProfile is an
 * encryption boundary that opens with its own password; the person is a fact
 * laid on top. Signing out removes the binding and leaves every local row alone.
 */

import { sha256Hex } from "@/lib/share/hash"
import { ORG_ID_PREFIX, USER_ID_PREFIX, type Org, type OrgRole, type User } from "@/types/identity"

import type { LogtoSession } from "@/lib/logto/client"
import { readLogtoIdentity, type LogtoIdentity } from "./logto-claims"
import { UserBindingRegistry, type BindUserInput } from "./user-binding"

import type { UserBindingRow } from "@/lib/accounts/account-db"

/** How many hex characters of the digest an id carries. 24 ≈ 96 bits. */
const DERIVED_ID_LENGTH = 24

async function deriveId(prefix: string, ...parts: string[]): Promise<string> {
  const digest = await sha256Hex(parts.join("\n"))
  return `${prefix}${digest.slice(0, DERIVED_ID_LENGTH)}`
}

/**
 * The id a person gets the first time they sign in on any machine. Stable
 * across machines for one `(issuer, subject)` pair, which is the entire point.
 */
export async function deriveUserId(issuer: string, subject: string): Promise<string> {
  return deriveId(USER_ID_PREFIX, "user", issuer, subject)
}

/** The same, for the Org mirroring a Logto organization. */
export async function deriveOrgId(issuer: string, logtoOrganizationId: string): Promise<string> {
  return deriveId(ORG_ID_PREFIX, "org", issuer, logtoOrganizationId)
}

export interface SignedInIdentity {
  user: User
  org?: Org
  /** Absent when the token carried no organization to take a role in. */
  orgRole?: OrgRole
  binding: UserBindingRow
}

/**
 * A place to mirror the resolved identity into a queryable projection.
 *
 * Left injectable and optional because the projection tables land in a later
 * slice, and because ADR-0149 §6 makes the collaboration server authoritative
 * for them — the client's copy is a cache, so the writer belongs behind a seam
 * rather than inlined here.
 */
export interface IdentityProjectionWriter {
  upsert(identity: SignedInIdentity): Promise<void>
}

export interface BindSignedInIdentityDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId: string
  registry?: UserBindingRegistry
  projection?: IdentityProjectionWriter
  /** Take the profile over if it belongs to somebody else. Explicit, never a default. */
  takeOverProfile?: boolean
  now?: () => number
}

export class SignInError extends Error {
  constructor(
    readonly code: "unreadable-token",
    message: string
  ) {
    super(message)
    this.name = "SignInError"
  }
}

/** Build the `User`/`Org` pair a set of Logto claims describes. */
export async function resolveIdentityFromClaims(
  identity: LogtoIdentity,
  issuer: string,
  now: number
): Promise<{ user: User; org?: Org; orgRole?: OrgRole }> {
  const { access, profile, orgRole } = identity

  const user: User = {
    id: await deriveUserId(issuer, access.subject),
    // Falling back to the subject keeps a roster readable when Logto asserted
    // no profile at all; it is a label, and it is replaced on the next sign-in
    // that carries one.
    displayName: profile.name ?? profile.email ?? access.subject,
    createdAt: now,
    updatedAt: now,
  }
  if (profile.email) user.email = profile.email
  if (profile.picture) user.avatarUrl = profile.picture

  if (!access.organizationId) return { user }

  const org: Org = {
    id: await deriveOrgId(issuer, access.organizationId),
    displayName: access.organizationId,
    logtoOrganizationId: access.organizationId,
    createdAt: now,
    updatedAt: now,
  }
  return { user, org, orgRole }
}

/**
 * Read a Logto session, resolve the person it describes, and bind this profile
 * to them.
 *
 * Throws `SignInError` when the access token carries no readable subject —
 * the only case in which there is no person to bind. A profile that already
 * belongs to somebody else raises `UserBindingError`, unless `takeOverProfile`
 * says the caller meant it.
 */
export async function bindSignedInIdentity(
  session: LogtoSession,
  deps: BindSignedInIdentityDeps
): Promise<SignedInIdentity> {
  const identity = readLogtoIdentity(session)
  if (!identity) {
    throw new SignInError(
      "unreadable-token",
      "The Logto access token carries no subject, so there is no person to bind this profile to."
    )
  }

  const now = (deps.now ?? Date.now)()
  const registry = deps.registry ?? new UserBindingRegistry()
  const { user, org, orgRole } = await resolveIdentityFromClaims(identity, session.issuer, now)

  const input: BindUserInput = {
    localAccountId: deps.localAccountId,
    userId: user.id,
    logtoSubject: identity.access.subject,
    logtoIssuer: session.issuer,
    now,
  }
  if (org) input.orgId = org.id
  if (user.displayName) input.displayName = user.displayName
  if (user.email) input.email = user.email

  const binding = deps.takeOverProfile ? await registry.rebind(input) : await registry.bind(input)

  const resolved: SignedInIdentity = { user, binding }
  if (org) resolved.org = org
  if (orgRole) resolved.orgRole = orgRole

  await deps.projection?.upsert(resolved)
  return resolved
}
