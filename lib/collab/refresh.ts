/**
 * The one place the collaboration plane is actually pulled — ADR-0149 §6.
 *
 * # Why Batch 7 starts here
 *
 * Batches 3, 5 and 6 each built a working piece of this plane and each ended
 * the same way: nothing called it. `pullCollabIssues` had no production
 * caller, `workspaceMemberships` had no writer, and the share service's org
 * routes had no client. All three were waiting on the same missing thing — a
 * place that knows where the server is, who is signed in, and when to ask.
 *
 * This is that place, and it is host-neutral on purpose: `lib/issues/boot.ts`
 * runs it on the desktop and the cloud brain runs the same body.
 *
 * # Unconfigured is not an error
 *
 * A profile with no collaboration server, or one nobody has signed in on, is
 * the ordinary state. It reports `skipped` with a reason rather than throwing,
 * because a caller that has to distinguish "not set up" from "the network is
 * down" by parsing an error message will eventually get it wrong.
 *
 * Memberships are pulled BEFORE issues. The board renders what the mirror
 * holds; who you are decides what you may see of it, and refreshing the rows
 * before the standing that explains them is the order that shows a stale
 * badge rather than a wrong one.
 */

import { loggers } from "@cognia/logging"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { reconcileUserId, type ReconcileUserIdDeps } from "@/lib/identity/reconcile-user-id"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { readActiveAccessToken } from "@/lib/logto/app-session"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

import { CollabClient, type CollabFetch } from "./client"
import { loadCollabConnection } from "./connection"
import {
  pullCollabActivity,
  pullCollabIssues,
  pullCollabMemberships,
  pullCollabWorkspaces,
} from "./sync"

const log = loggers.shell

export type CollabSkipReason =
  /** No collaboration server is configured for this profile. */
  | "not-configured"
  /** Nobody has signed in on this profile, so there is no person to be. */
  | "not-signed-in"
  /** Signed in, but the binding names no org — a personal account. */
  | "no-org"

export type RefreshCollabPlaneResult =
  | { status: "skipped"; reason: CollabSkipReason }
  | {
      status: "refreshed"
      orgId: string
      userId: string
      /**
       * Set when this refresh replaced a locally derived user id with the one
       * the server assigned. Names the id that was retired.
       */
      reconciledFrom?: string
      issues: number
      /** Workspaces this person holds, from `memberships/me`. */
      workspaces: number
      /** People across every roster pulled — 0 until a roster is readable. */
      members: number
      orgMember: boolean
      /** Plan headers mirrored for this org. */
      plans: number
      /** Runs mirrored for this org. */
      runs: number
    }

export interface RefreshCollabPlaneDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId?: string
  registry?: UserBindingRegistry
  fetchImpl?: CollabFetch
  /** Injectable so a test need not reach the keyring. */
  accessToken?: (localAccountId: string) => Promise<string | null>
  /** Injectable so the id reconciliation can be observed without a host. */
  reconcile?: (
    input: Parameters<typeof reconcileUserId>[0],
    deps?: ReconcileUserIdDeps
  ) => Promise<unknown>
  now?: () => number
}

/**
 * A token that is good now, refreshed if it had to be. Reading the keyring
 * directly would hand the plane an expired token and turn "refresh me" into a
 * 401 indistinguishable from a revoked login.
 */
async function defaultAccessToken(localAccountId: string): Promise<string | null> {
  return readActiveAccessToken(localAccountId)
}

/**
 * Refresh this profile's slice of the collaboration plane.
 *
 * Throws only when a configured, signed-in profile could not be refreshed —
 * which is a real failure a caller may want to surface. Everything else comes
 * back as `skipped`.
 */
export async function refreshCollabPlane(
  deps: RefreshCollabPlaneDeps = {}
): Promise<RefreshCollabPlaneResult> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()

  const connection = loadCollabConnection(localAccountId)
  if (!connection) return { status: "skipped", reason: "not-configured" }

  const registry = deps.registry ?? new UserBindingRegistry()
  const binding = await registry.get(localAccountId)
  if (!binding) return { status: "skipped", reason: "not-signed-in" }
  if (!binding.orgId) return { status: "skipped", reason: "no-org" }

  const readToken = deps.accessToken ?? defaultAccessToken
  const client = new CollabClient({
    baseUrl: connection.baseUrl,
    accessToken: () => readToken(localAccountId),
    // The platform transport rather than bare `fetch`: the desktop routes
    // through the configured proxy, and a direct fetch here would be the one
    // call that ignored it.
    fetchImpl: deps.fetchImpl ?? createPlatformFetch(),
    ...(deps.now ? { now: deps.now } : {}),
  })

  // The server is the authority for who this person IS. A profile bound
  // before the server existed carries a derived id, and every row the pulls
  // below write would otherwise land under a different person. Reconciling
  // FIRST is what makes those rows, and "assigned to me", line up.
  const identity = await client.identity(binding.orgId)
  let reconciledFrom: string | undefined
  if (binding.userId && identity.userId !== binding.userId) {
    const token = await readToken(localAccountId)
    await (deps.reconcile ?? reconcileUserId)(
      {
        localAccountId,
        legacyUserId: binding.userId,
        canonicalUserId: identity.userId,
        orgId: binding.orgId,
        ...(token ? { accessToken: token } : {}),
        ...(deps.now ? { now: deps.now() } : {}),
      },
      { registry: deps.registry }
    )
    reconciledFrom = binding.userId
    log.info("collab: reconciled the profile to the server's user id", {
      from: binding.userId,
      to: identity.userId,
    })
  }

  const memberships = await pullCollabMemberships(
    client,
    { orgId: binding.orgId },
    ...(deps.now ? [{ now: deps.now }] : [])
  )
  // Workspaces second: their rosters write OTHER people into the projection,
  // and doing that before this caller's own memberships are settled would let
  // a roster's `orgMember` fact race the authoritative answer about oneself.
  const workspaces = await pullCollabWorkspaces(
    client,
    { orgId: binding.orgId },
    ...(deps.now ? [{ now: deps.now }] : [])
  )
  const issues = await pullCollabIssues(
    client,
    { orgId: binding.orgId },
    ...(deps.now ? [{ now: deps.now }] : [])
  )
  // Last, because it is the only leg the board does not need. Issues are what
  // a person opens the app for; plans and runs say what is happening TO them,
  // and a slow activity listing must not delay the rows it annotates.
  const activity = await pullCollabActivity(
    client,
    { orgId: binding.orgId },
    ...(deps.now ? [{ now: deps.now }] : [])
  )

  return {
    status: "refreshed",
    orgId: binding.orgId,
    userId: memberships.userId,
    ...(reconciledFrom ? { reconciledFrom } : {}),
    issues: issues.count,
    workspaces: memberships.workspaces,
    members: workspaces.members,
    orgMember: memberships.orgMember,
    plans: activity.plans,
    runs: activity.runs,
  }
}

/**
 * Best-effort refresh for a boot path.
 *
 * A collaboration server that is unreachable at start-up must not stop the
 * issue tracker from booting: the board's local rows are the ones that matter
 * most, and they need no network at all.
 */
export async function refreshCollabPlaneQuietly(
  deps: RefreshCollabPlaneDeps = {}
): Promise<RefreshCollabPlaneResult | null> {
  try {
    return await refreshCollabPlane(deps)
  } catch (error) {
    log.warn("collab: refresh failed", { error: String(error) })
    return null
  }
}
