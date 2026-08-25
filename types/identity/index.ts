/**
 * People, organisations and membership — ADR-0149.
 *
 * # Why these types did not exist before
 *
 * Cognia was single-user by design across eight accepted ADRs, so the product
 * had a `LocalProfile` (`acct_…`, a password plus a physical Dexie database),
 * a `Device` (a P-256 keypair) and an `Org` (`tnt_…`, pinned 1:1 to a profile)
 * — and no entity for a human being. Authorization therefore hung off
 * hardware: ADR-0133 says outright that "removing the grant is the 'kick'".
 *
 * A `User` is the missing subject. Everything else here exists to answer one
 * question — "may this person do this thing in this workspace?" — without
 * asking which laptop they happen to be holding.
 *
 * # The id is ours, the subject is theirs
 *
 * `User.id` (`usr_…`) is the only key anything joins on. A Logto `sub`, a Lark
 * `open_id` and a GitHub login are all `ExternalIdentity` rows pointing at it.
 * That indirection is the whole reason the same human arriving from Lark today
 * and from the web tomorrow is one person, and it is why swapping the IdP later
 * is a data migration in one table rather than in every table.
 */

/** ADR-0149 §1 froze the vocabulary; these prefixes are the machine half of it. */
export const USER_ID_PREFIX = "usr_"
export const ORG_ID_PREFIX = "org_"

/**
 * Three characters minimum after the prefix. Machine-minted ids are 24, so
 * this floor exists only to reject the empty and near-empty shapes a bug
 * produces — `usr_`, `usr_a` — not to make the id look impressive.
 */
export const USER_ID_PATTERN = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/
export const ORG_ID_PATTERN = /^org_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

/**
 * Roles inside an Org, most privileged first.
 *
 *   owner  — the last-one-out role: may not be removed while they are the only
 *            one, mirroring `SecurityStore`'s `LastOwner` guard for devices.
 *   admin  — may traverse into any Workspace in the Org. This is deliberate and
 *            ADR-0149 §4 rejects hiding a Workspace from its own Org's admin:
 *            off-boarding, audit and compliance all need a way in.
 *   member — belongs to the Org, and sees exactly the Workspaces they were
 *            recruited into. Org membership grants no Workspace access at all.
 */
export const ORG_ROLES = ["owner", "admin", "member"] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/**
 * Roles inside a Workspace, most privileged first. Recruited independently of
 * the Org (the Linear model), because ADR-0149 §4 rejected the Notion model
 * where an Org role cascades down — that can only ever over-grant.
 */
export const WORKSPACE_ROLES = ["maintainer", "member", "viewer"] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

/** What a role lets you do. Ranked, so a check is a comparison rather than a table. */
export const WORKSPACE_CAPABILITIES = ["read", "write", "manage"] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

const WORKSPACE_ROLE_CAPABILITY: Record<WorkspaceRole, WorkspaceCapability> = {
  maintainer: "manage",
  member: "write",
  viewer: "read",
}

/** A person. The subject of every authorization decision from ADR-0149 onward. */
export interface User {
  /** `usr_…`. Stable forever; external subjects are never used as the key. */
  id: string
  displayName: string
  /** Present when an identity provider asserted one. Not a login credential. */
  email?: string
  avatarUrl?: string
  createdAt: number
  updatedAt: number
}

/**
 * Providers that can assert an identity. `logto` is the IdP proper; the rest
 * are places a person already is, which ADR-0149 §3 demotes from "subject" to
 * "one of this person's identities".
 */
export const EXTERNAL_IDENTITY_PROVIDERS = ["logto", "lark", "slack", "github", "matrix"] as const
export type ExternalIdentityProvider = (typeof EXTERNAL_IDENTITY_PROVIDERS)[number]

/**
 * One external subject bound to one `User`. This is the table `feishuPrincipals`
 * becomes in Batch 5 — its rows already carry `cogniaUserId` and `logtoSubject`,
 * they just had no `User` to point at.
 */
export interface ExternalIdentity {
  /** Deterministic: `provider:tenant:subject`, so re-linking is idempotent. */
  id: string
  userId: string
  provider: ExternalIdentityProvider
  /** The provider's stable id for this person — a Logto `sub`, a Lark `open_id`. */
  subject: string
  /** The provider-side tenant this subject lives in, when the provider has them. */
  tenant?: string
  /** Display label cached at link time so a roster renders without a round trip. */
  label?: string
  linkedAt: number
}

/** An ownership, billing and audit boundary. Mirrors one Logto organization. */
export interface Org {
  /** `org_…`. The `tnt_…` ids of ADR-0059 are the same concept, renamed. */
  id: string
  displayName: string
  /**
   * The Logto organization this Org mirrors. An external identifier, never a
   * foreign key — ADR-0149 §3. Absent for an Org that has no IdP behind it yet.
   */
  logtoOrganizationId?: string
  createdAt: number
  updatedAt: number
}

export interface OrgMembership {
  /** `${orgId}:${userId}` — one row per pair, so a re-invite cannot duplicate. */
  id: string
  orgId: string
  userId: string
  role: OrgRole
  createdAt: number
  updatedAt: number
}

export interface WorkspaceMembership {
  /** `${workspaceId}:${userId}`. */
  id: string
  /** A `projects` row id — the workspace of ADR-0144, unchanged. */
  workspaceId: string
  /** The Org that owns the workspace, denormalised so a check needs one read. */
  orgId: string
  userId: string
  role: WorkspaceRole
  createdAt: number
  updatedAt: number
}

/** How someone came to have access — the difference matters in an audit log. */
export type WorkspaceAccessVia = "membership" | "org-admin"

export interface EffectiveWorkspaceAccess {
  role: WorkspaceRole
  capability: WorkspaceCapability
  via: WorkspaceAccessVia
  /**
   * A guest holds Workspace membership without Org membership — ADR-0149 §4.
   * Derived, never stored: a stored flag would be a second source of truth that
   * drifts the moment someone is promoted into the Org.
   */
  guest: boolean
}

/**
 * Mint an id. Mirrors `generateAccountId` in `lib/accounts/account-db.ts`,
 * including its non-crypto fallback, so all three id spaces are minted the same
 * way and a reader comparing them finds no surprises.
 */
function generateId(prefix: string): string {
  const cryptoObject = globalThis.crypto
  if (typeof cryptoObject?.randomUUID === "function") {
    return `${prefix}${cryptoObject.randomUUID().replaceAll("-", "").slice(0, 24)}`
  }
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

export function generateUserId(): string {
  return generateId(USER_ID_PREFIX)
}

export function generateOrgId(): string {
  return generateId(ORG_ID_PREFIX)
}

export function isUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value)
}

export function isOrgId(value: string): boolean {
  return ORG_ID_PATTERN.test(value)
}

export function orgMembershipId(orgId: string, userId: string): string {
  return `${orgId}:${userId}`
}

export function workspaceMembershipId(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

export function externalIdentityId(
  provider: ExternalIdentityProvider,
  subject: string,
  tenant?: string
): string {
  return `${provider}:${tenant ?? ""}:${subject}`
}

/** True when the role may traverse into a Workspace they were never recruited into. */
export function canTraverseWorkspaces(role: OrgRole): boolean {
  return role === "owner" || role === "admin"
}

export function capabilityForRole(role: WorkspaceRole): WorkspaceCapability {
  return WORKSPACE_ROLE_CAPABILITY[role]
}

export function capabilityRank(capability: WorkspaceCapability): number {
  return WORKSPACE_CAPABILITIES.indexOf(capability)
}

/**
 * The effective-permission resolver — the one place two membership layers
 * collapse into an answer, in the shape `lib/workspace/capability-overlay.ts`
 * already uses for stacked capability state.
 *
 * The order is load-bearing. A direct Workspace membership wins even when the
 * person is also an Org admin, because their explicit role is what an audit log
 * should show, and because a maintainer who was deliberately made a `viewer`
 * somewhere should stay one.
 *
 * `null` means no access. Org membership alone never grants Workspace access.
 */
export function resolveWorkspaceAccess(input: {
  orgMembership?: Pick<OrgMembership, "role"> | null
  workspaceMembership?: Pick<WorkspaceMembership, "role"> | null
}): EffectiveWorkspaceAccess | null {
  const { orgMembership, workspaceMembership } = input

  if (workspaceMembership) {
    return {
      role: workspaceMembership.role,
      capability: capabilityForRole(workspaceMembership.role),
      via: "membership",
      guest: !orgMembership,
    }
  }

  if (orgMembership && canTraverseWorkspaces(orgMembership.role)) {
    return {
      role: "maintainer",
      capability: "manage",
      via: "org-admin",
      guest: false,
    }
  }

  return null
}

/** Does this access clear the bar? `null` access never does. */
export function allowsCapability(
  access: EffectiveWorkspaceAccess | null,
  required: WorkspaceCapability
): boolean {
  if (!access) return false
  return capabilityRank(access.capability) >= capabilityRank(required)
}
