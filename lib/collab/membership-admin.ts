"use client"

/**
 * Membership administration against the collaboration plane. ADR-0149 section 4.
 *
 * # Why a module and not calls from the component
 *
 * The server has offered invitation, role and offboarding routes since the
 * membership control plane landed, and `CollabClient` now exposes them. What
 * was missing is the discipline around a write: every one of these mutates
 * rows the local projection MIRRORS, and the one writer allowed to touch that
 * projection is `lib/collab/sync.ts`, pulling from the server. So each
 * operation here does exactly two things. It asks the server, and it asks for
 * a refresh. Nothing here writes a membership row locally, and
 * `lib/db/workspace-membership-producers.test.ts` keeps it that way.
 *
 * # Authorization
 *
 * Decided by the server on every request. The `access` a caller resolved from
 * the projection is an affordance for what to SHOW. A refused write comes back
 * as a `CollabError` with the server's status and is surfaced, not retried.
 */

import { refreshCollabPlaneQuietly, type RefreshCollabPlaneResult } from "./refresh"
import { requestCollabRefresh } from "./refresh-scheduler"
import type {
  CollabClient,
  CollabInvitation,
  CreateCollabInvitationInput,
  IssuedCollabInvitation,
} from "./client"
import type { CurrentCollabContext } from "./runtime-client"

import type { OrgRole, WorkspaceRole } from "@/types/identity"

export interface MembershipAdminDeps {
  /** Injectable so a test observes the refresh without a network. */
  refresh?: (localAccountId: string) => Promise<RefreshCollabPlaneResult | null>
}

function refreshAfter(
  context: CurrentCollabContext,
  deps: MembershipAdminDeps
): Promise<RefreshCollabPlaneResult | null> {
  const refresh =
    deps.refresh ?? ((localAccountId: string) => refreshCollabPlaneQuietly({ localAccountId }))
  return requestCollabRefresh(context.localAccountId, refresh)
}

export interface InviteToWorkspaceInput {
  workspaceId: string
  role: WorkspaceRole
  reason: string
  expiresInDays?: number
}

export interface InviteToOrgInput {
  role: OrgRole
  reason: string
  expiresInDays?: number
}

/**
 * Mint a one-time invitation. The token in the result is shown ONCE and never
 * stored locally: the server keeps only its hash, and so does this app.
 */
export async function inviteToWorkspace(
  context: CurrentCollabContext,
  input: InviteToWorkspaceInput
): Promise<IssuedCollabInvitation> {
  const body: CreateCollabInvitationInput = {
    workspaceId: input.workspaceId,
    workspaceRole: input.role,
    reason: input.reason,
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
  }
  return context.client.createInvitation(context.orgId, body)
}

export async function inviteToOrg(
  context: CurrentCollabContext,
  input: InviteToOrgInput
): Promise<IssuedCollabInvitation> {
  const body: CreateCollabInvitationInput = {
    orgRole: input.role,
    reason: input.reason,
    ...(input.expiresInDays !== undefined ? { expiresInDays: input.expiresInDays } : {}),
  }
  return context.client.createInvitation(context.orgId, body)
}

/** Invitations this person may see. Read straight from the server: nothing mirrors them. */
export async function listInvitations(context: CurrentCollabContext): Promise<CollabInvitation[]> {
  return context.client.listInvitations(context.orgId)
}

export async function revokeInvitation(
  context: CurrentCollabContext,
  invitationId: string,
  reason?: string
): Promise<CollabInvitation> {
  return context.client.revokeInvitation(context.orgId, invitationId, reason)
}

export interface ChangeWorkspaceRoleInput {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  reason: string
}

/** Set (or change) somebody's seat in a workspace, then re-pull the roster. */
export async function changeWorkspaceRole(
  context: CurrentCollabContext,
  input: ChangeWorkspaceRoleInput,
  deps: MembershipAdminDeps = {}
): Promise<void> {
  await context.client.setWorkspaceMember(context.orgId, input.workspaceId, input.userId, {
    role: input.role,
    reason: input.reason,
  })
  await refreshAfter(context, deps)
}

export interface RemoveFromWorkspaceInput {
  workspaceId: string
  userId: string
  reason?: string
}

export async function removeFromWorkspace(
  context: CurrentCollabContext,
  input: RemoveFromWorkspaceInput,
  deps: MembershipAdminDeps = {}
): Promise<void> {
  await context.client.removeWorkspaceMember(
    context.orgId,
    input.workspaceId,
    input.userId,
    input.reason
  )
  await refreshAfter(context, deps)
}

export interface ChangeOrgRoleInput {
  userId: string
  role: OrgRole
  reason: string
}

export async function changeOrgRole(
  context: CurrentCollabContext,
  input: ChangeOrgRoleInput,
  deps: MembershipAdminDeps = {}
): Promise<void> {
  await context.client.setOrgMemberRole(context.orgId, input.userId, {
    role: input.role,
    reason: input.reason,
  })
  await refreshAfter(context, deps)
}

export interface OffboardFromOrgInput {
  userId: string
  reason?: string
}

/**
 * Remove every standing the person holds in the org: org membership, every
 * workspace seat, and any invitation they minted. One server transaction.
 */
export async function offboardFromOrg(
  context: CurrentCollabContext,
  input: OffboardFromOrgInput,
  deps: MembershipAdminDeps = {}
): Promise<void> {
  await context.client.offboardOrgMember(context.orgId, input.userId, input.reason)
  await refreshAfter(context, deps)
}

/** The client this module needs, for tests that build a bare stub. */
export type MembershipAdminClient = Pick<
  CollabClient,
  | "createInvitation"
  | "listInvitations"
  | "revokeInvitation"
  | "setWorkspaceMember"
  | "removeWorkspaceMember"
  | "setOrgMemberRole"
  | "offboardOrgMember"
>
