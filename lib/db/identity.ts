// People, organisations and membership — the client's readable copy (ADR-0149).
//
// # This is a projection, not an authority
//
// ADR-0149 §6 makes the collaboration server authoritative for these rows. The
// copy here exists so a roster, an assignee picker or a member count renders
// without a round trip, and so the app still shows who someone is while
// offline. It is NOT where a permission is decided: once Batch 3 lands, a write
// is authorized by the server, which re-reads its own tables. A client that
// gates a destructive action on `resolveWorkspaceAccessFor` alone has moved the
// decision to the least trustworthy machine in the system.
//
// `lib/data-governance/table-catalog.ts` records that classification, so the
// backup and sync layers treat these rows as rebuildable rather than precious.
//
// # Why the ids are deterministic
//
// `orgMembershipId` and `workspaceMembershipId` derive the primary key from the
// pair they join, so re-inviting somebody updates one row instead of growing a
// second. Nothing here needs a uniqueness index to defend that.

import {
  externalIdentityId,
  orgMembershipId,
  personStandingFrom,
  resolveWorkspaceAccess,
  workspaceMembershipId,
  type EffectiveWorkspaceAccess,
  type ExternalIdentity,
  type ExternalIdentityProvider,
  type Org,
  type OrgMembership,
  type OrgRole,
  type PersonStanding,
  type User,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "@/types/identity"

import { getDb } from "./schema"

export async function upsertUser(user: User): Promise<void> {
  await getDb().users.put(user)
}

export async function getUser(userId: string): Promise<User | undefined> {
  return getDb().users.get(userId)
}

export async function listUsers(userIds: readonly string[]): Promise<User[]> {
  if (userIds.length === 0) return []
  const rows = await getDb().users.bulkGet([...userIds])
  return rows.filter((row): row is User => row !== undefined)
}

export async function upsertOrg(org: Org): Promise<void> {
  await getDb().orgs.put(org)
}

export async function getOrg(orgId: string): Promise<Org | undefined> {
  return getDb().orgs.get(orgId)
}

export async function listOrgs(): Promise<Org[]> {
  return getDb().orgs.toArray()
}

export interface PutOrgMembershipInput {
  orgId: string
  userId: string
  role: OrgRole
  now?: number
}

export async function putOrgMembership(input: PutOrgMembershipInput): Promise<OrgMembership> {
  const now = input.now ?? Date.now()
  const id = orgMembershipId(input.orgId, input.userId)
  const db = getDb()
  const existing = await db.orgMemberships.get(id)
  const row: OrgMembership = {
    id,
    orgId: input.orgId,
    userId: input.userId,
    role: input.role,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await db.orgMemberships.put(row)
  return row
}

export async function getOrgMembership(
  orgId: string,
  userId: string
): Promise<OrgMembership | undefined> {
  return getDb().orgMemberships.get(orgMembershipId(orgId, userId))
}

export async function listOrgMembers(orgId: string): Promise<OrgMembership[]> {
  return getDb().orgMemberships.where("orgId").equals(orgId).toArray()
}

export async function listOrgsForUser(userId: string): Promise<OrgMembership[]> {
  return getDb().orgMemberships.where("userId").equals(userId).toArray()
}

export async function removeOrgMembership(orgId: string, userId: string): Promise<void> {
  await getDb().orgMemberships.delete(orgMembershipId(orgId, userId))
}

export interface PutWorkspaceMembershipInput {
  workspaceId: string
  orgId: string
  userId: string
  role: WorkspaceRole
  now?: number
}

export async function putWorkspaceMembership(
  input: PutWorkspaceMembershipInput
): Promise<WorkspaceMembership> {
  const now = input.now ?? Date.now()
  const id = workspaceMembershipId(input.workspaceId, input.userId)
  const db = getDb()
  const existing = await db.workspaceMemberships.get(id)
  const row: WorkspaceMembership = {
    id,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
    userId: input.userId,
    role: input.role,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await db.workspaceMemberships.put(row)
  return row
}

export async function getWorkspaceMembership(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMembership | undefined> {
  return getDb().workspaceMemberships.get(workspaceMembershipId(workspaceId, userId))
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
  return getDb().workspaceMemberships.where("workspaceId").equals(workspaceId).toArray()
}

/** Every workspace this person holds, optionally narrowed to one Org. */
export async function listWorkspacesForUser(
  userId: string,
  orgId?: string
): Promise<WorkspaceMembership[]> {
  const table = getDb().workspaceMemberships
  return orgId
    ? table.where("[userId+orgId]").equals([userId, orgId]).toArray()
    : table.where("userId").equals(userId).toArray()
}

export async function removeWorkspaceMembership(
  workspaceId: string,
  userId: string
): Promise<void> {
  await getDb().workspaceMemberships.delete(workspaceMembershipId(workspaceId, userId))
}

export interface LinkExternalIdentityInput {
  userId: string
  provider: ExternalIdentityProvider
  subject: string
  tenant?: string
  label?: string
  now?: number
}

/**
 * Point an external subject at a person. Idempotent on `(provider, tenant,
 * subject)`, and re-linking to a different `User` is an update rather than a
 * second row — which is exactly what "this Lark account is actually Ada"
 * should do.
 */
export async function linkExternalIdentity(
  input: LinkExternalIdentityInput
): Promise<ExternalIdentity> {
  const now = input.now ?? Date.now()
  const row: ExternalIdentity = {
    id: externalIdentityId(input.provider, input.subject, input.tenant),
    userId: input.userId,
    provider: input.provider,
    subject: input.subject,
    linkedAt: now,
  }
  if (input.tenant) row.tenant = input.tenant
  if (input.label) row.label = input.label
  await getDb().externalIdentities.put(row)
  return row
}

export async function listExternalIdentities(userId: string): Promise<ExternalIdentity[]> {
  return getDb().externalIdentities.where("userId").equals(userId).toArray()
}

/** Which person is this external subject? `undefined` when nobody claimed it. */
export async function findUserIdByExternalIdentity(
  provider: ExternalIdentityProvider,
  subject: string,
  tenant?: string
): Promise<string | undefined> {
  const row = await getDb().externalIdentities.get(externalIdentityId(provider, subject, tenant))
  return row?.userId
}

/**
 * Which person is this external subject, when the tenant is not known?
 *
 * The primary key encodes the tenant, so `findUserIdByExternalIdentity` cannot
 * answer for a caller that holds only a subject — and the IM plane is exactly
 * that caller: a `feishuPrincipals` row carries `logtoSubject` but never the
 * Logto issuer the projection filed it under.
 *
 * Safe here because ADR-0149 decision 6 makes the self-hosted Logto the single
 * IdP, so one subject is one person. It stays safe if that ever stops being
 * true, because an ambiguous match REFUSES rather than picking: two people
 * behind one subject is a state where guessing attributes somebody's messages
 * to somebody else.
 */
export async function findUserIdByProviderSubject(
  provider: ExternalIdentityProvider,
  subject: string
): Promise<string | undefined> {
  const rows = await getDb()
    .externalIdentities.where("subject")
    .equals(subject)
    .filter((row) => row.provider === provider)
    .toArray()
  const userIds = new Set(rows.map((row) => row.userId))
  if (userIds.size !== 1) return undefined
  return rows[0]?.userId
}

/** One workspace member, with the guest question already answered. */
export interface WorkspaceRosterEntry {
  membership: WorkspaceMembership
  /** Absent when the projection holds a membership but not yet the person. */
  user?: User
  /**
   * Workspace membership without membership in the Org that owns it —
   * ADR-0149 §4. Derived on every read; nothing stores it, so a promotion
   * needs no second write and cannot be forgotten.
   */
  guest: boolean
}

/**
 * Everyone in a workspace, each marked guest or not.
 *
 * One `orgMemberships` read per distinct Org rather than per member: a
 * workspace's members almost all share its Org, so the per-member query would
 * ask the same question N times.
 */
export async function listWorkspaceRoster(workspaceId: string): Promise<WorkspaceRosterEntry[]> {
  const memberships = await listWorkspaceMembers(workspaceId)
  if (memberships.length === 0) return []

  const db = getDb()
  const [users, orgMemberships] = await Promise.all([
    listUsers([...new Set(memberships.map((membership) => membership.userId))]),
    db.orgMemberships
      .where("orgId")
      .anyOf([...new Set(memberships.map((membership) => membership.orgId))])
      .toArray(),
  ])

  const usersById = new Map(users.map((user) => [user.id, user]))
  const inOrg = new Set(orgMemberships.map((row) => `${row.orgId}:${row.userId}`))

  return memberships
    .map((membership) => {
      const user = usersById.get(membership.userId)
      return {
        membership,
        ...(user ? { user } : {}),
        guest: !inOrg.has(`${membership.orgId}:${membership.userId}`),
      }
    })
    .sort((left, right) =>
      (left.user?.displayName ?? left.membership.userId).localeCompare(
        right.user?.displayName ?? right.membership.userId
      )
    )
}

export interface RosterMemberInput {
  userId: string
  displayName: string
  role: WorkspaceRole
  /** Whether the server says this person also belongs to the owning Org. */
  orgMember: boolean
}

/**
 * Replace one workspace's roster with what the server reported.
 *
 * Scoped to that workspace: the projection holds rows for other workspaces
 * this pull was never told about, and wiping the org would delete facts rather
 * than refresh them.
 *
 * Writes an `orgMemberships` row for a member the server says is in the org,
 * and removes one for a member it says is not — because `guest` is derived
 * from exactly that absence. A stale org membership here is the difference
 * between somebody reading as a colleague and reading as a guest.
 */
export async function replaceWorkspaceRoster(input: {
  workspaceId: string
  orgId: string
  members: readonly RosterMemberInput[]
  now?: number
}): Promise<void> {
  const now = input.now ?? Date.now()
  const keep = new Set(input.members.map((member) => member.userId))

  const existing = await listWorkspaceMembers(input.workspaceId)
  for (const row of existing) {
    if (!keep.has(row.userId)) {
      await removeWorkspaceMembership(input.workspaceId, row.userId)
    }
  }

  for (const member of input.members) {
    const existingUser = await getUser(member.userId)
    await upsertUser({
      id: member.userId,
      displayName: member.displayName || existingUser?.displayName || member.userId,
      ...(existingUser?.email ? { email: existingUser.email } : {}),
      ...(existingUser?.avatarUrl ? { avatarUrl: existingUser.avatarUrl } : {}),
      createdAt: existingUser?.createdAt ?? now,
      updatedAt: now,
    })
    await putWorkspaceMembership({
      workspaceId: input.workspaceId,
      orgId: input.orgId,
      userId: member.userId,
      role: member.role,
      now,
    })
    if (member.orgMember) {
      const current = await getOrgMembership(input.orgId, member.userId)
      // Only fill an absent one: the roster reports THAT somebody is in the
      // org, not with which role, and inventing `member` would overwrite an
      // owner with a demotion nobody asked for.
      if (!current) {
        await putOrgMembership({ orgId: input.orgId, userId: member.userId, role: "member", now })
      }
    } else {
      await removeOrgMembership(input.orgId, member.userId)
    }
  }
}

/**
 * Where this person stands across every Org on this machine.
 *
 * The Lark principals card reads it to say what a bound IM sender actually
 * has: `unaffiliated` is the honest answer for somebody the registry knows and
 * nobody has given access to, and it is the state most of them are in.
 */
export async function resolvePersonStanding(userId: string): Promise<PersonStanding> {
  const db = getDb()
  const [orgMemberships, workspaceMemberships] = await Promise.all([
    db.orgMemberships.where("userId").equals(userId).count(),
    db.workspaceMemberships.where("userId").equals(userId).count(),
  ])
  return personStandingFrom({ orgMemberships, workspaceMemberships })
}

export async function unlinkExternalIdentity(
  provider: ExternalIdentityProvider,
  subject: string,
  tenant?: string
): Promise<void> {
  await getDb().externalIdentities.delete(externalIdentityId(provider, subject, tenant))
}

/**
 * Read both membership layers and collapse them.
 *
 * A UI affordance — see the header. Use it to decide what to SHOW, never to
 * decide what may happen.
 */
export async function resolveWorkspaceAccessFor(input: {
  userId: string
  orgId: string
  workspaceId: string
}): Promise<EffectiveWorkspaceAccess | null> {
  const [orgMembership, workspaceMembership] = await Promise.all([
    getOrgMembership(input.orgId, input.userId),
    getWorkspaceMembership(input.workspaceId, input.userId),
  ])
  return resolveWorkspaceAccess({
    orgMembership: orgMembership ?? null,
    workspaceMembership: workspaceMembership ?? null,
  })
}
