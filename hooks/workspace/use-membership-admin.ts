"use client"

/**
 * What the signed-in person may do to a workspace's roster, and the calls to
 * do it. ADR-0149 section 4.
 *
 * # Two sources, one answer
 *
 * Whether the controls are ENABLED comes from the local projection
 * (`resolveWorkspaceAccessFor`, `getOrgMembership`): it needs no network and
 * it is what the roster itself is drawn from, so the affordance and the list
 * never disagree. Whether a write is ALLOWED is the server's decision on every
 * request. A refused write surfaces as an error on this hook. That split is
 * the one `lib/db/identity.ts` insists on, and it is why nothing here
 * pre-checks a role before calling.
 *
 * # Who "you" are
 *
 * The binding names the canonical user id and, after a reconciliation, the
 * derived ids the profile used to carry. A roster row still under one of
 * those is still this person, so `selfUserIds` carries all of them. That is
 * the reader `legacyUserIds` was written for.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { CollabError } from "@/lib/collab/client"
import type { RefreshCollabPlaneResult } from "@/lib/collab/refresh"
import {
  changeOrgRole,
  changeWorkspaceRole,
  inviteToOrg,
  inviteToWorkspace,
  listInvitations,
  offboardFromOrg,
  removeFromWorkspace,
  revokeInvitation,
  type ChangeOrgRoleInput,
  type ChangeWorkspaceRoleInput,
  type InviteToOrgInput,
  type InviteToWorkspaceInput,
  type MembershipAdminDeps,
  type OffboardFromOrgInput,
  type RemoveFromWorkspaceInput,
} from "@/lib/collab/membership-admin"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"
import { getOrgMembership, resolveWorkspaceAccessFor } from "@/lib/db/identity"
import { UserBindingRegistry } from "@/lib/identity/user-binding"

import type { CollabInvitation, IssuedCollabInvitation } from "@/lib/collab/client"
import type { EffectiveWorkspaceAccess, OrgRole } from "@/types/identity"

export type MembershipAdminUnavailableReason = "not-configured" | "not-signed-in" | "no-org"

export interface MembershipAdminState {
  status: "loading" | "unavailable" | "ready"
  reason: MembershipAdminUnavailableReason | null
  context: CurrentCollabContext | null
  /** This person's access in the workspace, from the projection. */
  access: EffectiveWorkspaceAccess | null
  orgRole: OrgRole | null
  /** Maintainer of this workspace, or an org owner/admin traversing into it. */
  canManageWorkspace: boolean
  /** Org owner or admin: may change org roles and offboard. */
  canManageOrg: boolean
  selfUserId: string | null
  /** The canonical id plus every legacy alias the binding remembers. */
  selfUserIds: string[]
  busy: boolean
  /** The last refused or failed write. Cleared by the next attempt. */
  error: MembershipAdminFailure | null
  inviteToWorkspace: (
    input: Omit<InviteToWorkspaceInput, "workspaceId">
  ) => Promise<IssuedCollabInvitation>
  inviteToOrg: (input: InviteToOrgInput) => Promise<IssuedCollabInvitation>
  changeWorkspaceRole: (input: Omit<ChangeWorkspaceRoleInput, "workspaceId">) => Promise<void>
  removeFromWorkspace: (input: Omit<RemoveFromWorkspaceInput, "workspaceId">) => Promise<void>
  changeOrgRole: (input: ChangeOrgRoleInput) => Promise<void>
  offboardFromOrg: (input: OffboardFromOrgInput) => Promise<void>
  /** Read from the server each time: invitations are not mirrored locally. */
  listInvitations: () => Promise<CollabInvitation[]>
  revokeInvitation: (invitationId: string, reason: string) => Promise<CollabInvitation>
}

export interface UseMembershipAdminDeps extends MembershipAdminDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
  registry?: Pick<UserBindingRegistry, "get">
  refresh?: (localAccountId: string) => Promise<RefreshCollabPlaneResult | null>
}

/**
 * Why a write did not happen, in a shape the component can translate.
 *
 * The hook never produces user-facing text: a string here would be English
 * in every locale. `refused` carries the server's status and its own message,
 * which the component shows as detail under a translated headline.
 */
export type MembershipAdminFailure =
  | { kind: "not-available" }
  | { kind: "no-workspace" }
  | { kind: "refused"; status: number; message: string }
  | { kind: "failed"; message: string }

export class MembershipAdminError extends Error {
  constructor(readonly failure: MembershipAdminFailure) {
    super(failure.kind)
    this.name = "MembershipAdminError"
  }
}

export function toMembershipAdminFailure(error: unknown): MembershipAdminFailure {
  if (error instanceof MembershipAdminError) return error.failure
  if (error instanceof CollabError) {
    return { kind: "refused", status: error.status, message: error.message }
  }
  return { kind: "failed", message: describeAdminError(error) }
}

/**
 * The translation key and values for a failure, under `workspace.members`.
 * A 401 and a 403 have their own sentences because they have their own
 * remedies. Everything else quotes the server.
 */
export function membershipFailureMessage(failure: MembershipAdminFailure): {
  key: string
  values?: Record<string, string>
} {
  switch (failure.kind) {
    case "not-available":
      return { key: "errors.notAvailable" }
    case "no-workspace":
      return { key: "errors.noWorkspace" }
    case "refused":
      if (failure.status === 401) return { key: "errors.notSignedIn" }
      if (failure.status === 403) return { key: "errors.forbidden" }
      return { key: "errors.server", values: { message: failure.message } }
    case "failed":
      return { key: "errors.server", values: { message: failure.message } }
  }
}

/** Which "unavailable" the absence of a context is. */
async function unavailableReason(
  registry: Pick<UserBindingRegistry, "get">
): Promise<MembershipAdminUnavailableReason> {
  const binding = await registry.get(getActiveAccountId())
  if (!binding) return "not-signed-in"
  if (!binding.orgId) return "no-org"
  return "not-configured"
}

export function describeAdminError(error: unknown): string {
  if (error instanceof CollabError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export function useMembershipAdmin(
  workspaceId: string | null,
  deps: UseMembershipAdminDeps = {}
): MembershipAdminState {
  const [context, setContext] = useState<CurrentCollabContext | null>(null)
  const [status, setStatus] = useState<MembershipAdminState["status"]>("loading")
  const [reason, setReason] = useState<MembershipAdminUnavailableReason | null>(null)
  const [selfUserIds, setSelfUserIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<MembershipAdminFailure | null>(null)

  const resolveContext = deps.resolveContext ?? resolveCurrentCollabContext
  const registry = useMemo(() => deps.registry ?? new UserBindingRegistry(), [deps.registry])

  useEffect(() => {
    let cancelled = false
    // Deferred so the async resolution never sets state synchronously inside
    // the effect body (react-hooks/set-state-in-effect), the same shape the
    // collaboration card uses.
    queueMicrotask(() => {
      void (async () => {
        try {
          const [resolved, binding] = await Promise.all([
            resolveContext(),
            registry.get(getActiveAccountId()),
          ])
          if (cancelled) return
          setSelfUserIds(binding ? [binding.userId, ...(binding.legacyUserIds ?? [])] : [])
          if (resolved) {
            setContext(resolved)
            setReason(null)
            setStatus("ready")
          } else {
            setContext(null)
            setReason(await unavailableReason(registry))
            setStatus("unavailable")
          }
        } catch (cause) {
          if (cancelled) return
          setContext(null)
          setReason("not-configured")
          setStatus("unavailable")
          setError(toMembershipAdminFailure(cause))
        }
      })()
    })
    return () => {
      cancelled = true
    }
  }, [resolveContext, registry])

  const accessQuery = useLiveQuery<EffectiveWorkspaceAccess | null>(
    () =>
      typeof window === "undefined" || !context || !workspaceId
        ? Promise.resolve(null)
        : resolveWorkspaceAccessFor({
            userId: context.userId,
            orgId: context.orgId,
            workspaceId,
          }),
    [context, workspaceId]
  )
  const access = accessQuery ?? null

  const orgRoleQuery = useLiveQuery<OrgRole | null>(async () => {
    if (typeof window === "undefined" || !context) return null
    const membership = await getOrgMembership(context.orgId, context.userId)
    return membership?.role ?? null
  }, [context])
  const orgRole = orgRoleQuery ?? null

  const run = useCallback(
    async <T>(action: (ready: CurrentCollabContext) => Promise<T>): Promise<T> => {
      if (!context) {
        const failure: MembershipAdminFailure = { kind: "not-available" }
        setError(failure)
        throw new MembershipAdminError(failure)
      }
      setBusy(true)
      setError(null)
      try {
        return await action(context)
      } catch (cause) {
        setError(toMembershipAdminFailure(cause))
        throw cause
      } finally {
        setBusy(false)
      }
    },
    [context]
  )

  const adminDeps: MembershipAdminDeps = useMemo(
    () => (deps.refresh ? { refresh: deps.refresh } : {}),
    [deps.refresh]
  )

  const canManageOrg = orgRole === "owner" || orgRole === "admin"
  const canManageWorkspace = access?.capability === "manage"

  return {
    status,
    reason,
    context,
    access,
    orgRole,
    canManageWorkspace,
    canManageOrg,
    selfUserId: context?.userId ?? selfUserIds[0] ?? null,
    selfUserIds,
    busy,
    error,
    inviteToWorkspace: (input) =>
      run((ready) => {
        if (!workspaceId) throw new MembershipAdminError({ kind: "no-workspace" })
        return inviteToWorkspace(ready, { ...input, workspaceId })
      }),
    inviteToOrg: (input) => run((ready) => inviteToOrg(ready, input)),
    changeWorkspaceRole: (input) =>
      run((ready) => {
        if (!workspaceId) throw new MembershipAdminError({ kind: "no-workspace" })
        return changeWorkspaceRole(ready, { ...input, workspaceId }, adminDeps)
      }),
    removeFromWorkspace: (input) =>
      run((ready) => {
        if (!workspaceId) throw new MembershipAdminError({ kind: "no-workspace" })
        return removeFromWorkspace(ready, { ...input, workspaceId }, adminDeps)
      }),
    changeOrgRole: (input) => run((ready) => changeOrgRole(ready, input, adminDeps)),
    offboardFromOrg: (input) => run((ready) => offboardFromOrg(ready, input, adminDeps)),
    listInvitations: () => run((ready) => listInvitations(ready)),
    revokeInvitation: (invitationId, reason) =>
      run((ready) => revokeInvitation(ready, invitationId, reason)),
  }
}
