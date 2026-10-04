/**
 * Joining a login to the Feishu principals that person already holds
 * (ADR-0149 §3, ADR-0215 §9).
 *
 * A principal is keyed by `tenantKey + appId + openId`, an id scoped to one
 * bot app. A Feishu sign-in is filed as `lark:<tenantKey>:<union_id>` (see
 * `lib/identity/link-signed-in-identities.ts`). The two meet only through the
 * `union_id` the principal records, so this module is the one place that
 * writes the login's subject onto a principal.
 *
 * # Never somebody else's principal
 *
 * A principal is updated only when it already belongs to the signed-in
 * person. One whose `cogniaUserId` names another `User` (an IM-first person
 * minted before this login existed) is reported, not taken over: collapsing
 * two people is an operator decision, as everywhere else on the identity
 * plane.
 */

import type { FeishuPrincipalBindRequestRow, FeishuPrincipalRow } from "@/lib/db/connector-types"
import { findUserIdByExternalIdentity, listExternalIdentities } from "@/lib/db/identity"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import {
  listFeishuPrincipalsByUnionId,
  rebindFeishuPrincipal,
  setFeishuPrincipalStatus,
} from "@/lib/db/feishu-principals"
import { getDb } from "@/lib/db/schema"
import type { ExternalIdentity } from "@/types/identity"

/**
 * The Logto subject a person signed in with, when exactly one is known.
 *
 * Zero subjects means the person never signed in. Two means two deployments
 * minted subjects for one person; picking one would be a guess, so neither is
 * returned.
 */
export async function logtoSubjectForUser(
  userId: string,
  list: typeof listExternalIdentities = listExternalIdentities
): Promise<string | undefined> {
  const subjects = new Set(
    (await list(userId))
      .filter((identity) => identity.provider === "logto")
      .map((identity) => identity.subject)
  )
  return subjects.size === 1 ? [...subjects][0] : undefined
}

export interface AttachSignInInput {
  /** The signed-in person. */
  userId: string
  /** Their Logto subject, from the user binding. */
  logtoSubject: string
  /** The external identities the sign-in just linked onto `userId`. */
  identities: readonly ExternalIdentity[]
  now?: number
}

export interface AttachSignInReport {
  /** Principals that now carry the login's subject. */
  attached: string[]
  /** Principals whose union id matched but which belong to another person. */
  foreign: string[]
}

export interface AttachSignInDeps {
  listByUnionId?: typeof listFeishuPrincipalsByUnionId
  rebind?: typeof rebindFeishuPrincipal
}

export async function attachSignInToFeishuPrincipals(
  input: AttachSignInInput,
  deps: AttachSignInDeps = {}
): Promise<AttachSignInReport> {
  const listByUnionId = deps.listByUnionId ?? listFeishuPrincipalsByUnionId
  const rebind = deps.rebind ?? rebindFeishuPrincipal
  const report: AttachSignInReport = { attached: [], foreign: [] }
  const logtoSubject = input.logtoSubject.trim()
  if (!logtoSubject) return report

  const seen = new Set<string>()
  for (const identity of input.identities) {
    if (identity.provider !== "lark" || identity.userId !== input.userId) continue
    // A union id is filed under its tenant; an untenanted lark subject cannot
    // be told apart from an open id and names no principal safely.
    if (!identity.tenant) continue
    const principals: FeishuPrincipalRow[] = await listByUnionId(identity.tenant, identity.subject)
    for (const principal of principals) {
      if (seen.has(principal.id)) continue
      seen.add(principal.id)
      if (principal.cogniaUserId !== input.userId) {
        report.foreign.push(principal.id)
        continue
      }
      // An existing subject stays: the same person holding a different one
      // means a second deployment, and the first subject is not wrong.
      if (principal.logtoSubject) continue
      await rebind(principal.id, { logtoSubject }, input.now)
      report.attached.push(principal.id)
    }
  }
  return report
}

export interface UnlinkSelfBoundInput {
  localAccountId: string
  /** The person the profile was bound to before the sign-out or takeover. */
  userId: string
  now?: number
}

/**
 * Unlink every principal this path admitted for a person on a profile.
 *
 * Called when the binding that justified them goes away: a sign-out
 * (`completeSignOut`), or a different person taking the profile over
 * (`bindSignedInIdentity` with `takeOverProfile`). `principal/self-bind.ts`
 * re-activates them when the same person is back. Principals an operator approved
 * (including the owner's own confirmed one) are left as they are.
 */
export async function unlinkSelfBoundPrincipals(input: UnlinkSelfBoundInput): Promise<string[]> {
  const now = input.now ?? Date.now()
  const rows = await getDb()
    .feishuPrincipals.where("cogniaUserId")
    .equals(input.userId)
    .filter(
      (row) =>
        row.cogniaAccountId === input.localAccountId &&
        row.selfBoundAt !== undefined &&
        row.status === "active"
    )
    .toArray()
  for (const row of rows) {
    await setFeishuPrincipalStatus(row.id, "unlinked", now)
  }
  return rows.map((row) => row.id)
}

/** The person a profile is signed in as, in the shape the bind-request UI needs. */
export interface SignedInOwner {
  userId: string
  /** Ids the binding was known under before the server assigned `userId`. */
  legacyUserIds: string[]
  displayName?: string
}

export async function readSignedInOwner(
  localAccountId: string,
  registry: Pick<UserBindingRegistry, "get"> = new UserBindingRegistry()
): Promise<SignedInOwner | null> {
  const binding = await registry.get(localAccountId)
  if (!binding) return null
  return {
    userId: binding.userId,
    legacyUserIds: binding.legacyUserIds ?? [],
    ...(binding.displayName ? { displayName: binding.displayName } : {}),
  }
}

/**
 * Whether a bind request's sender is the Feishu identity the owner signed in
 * with, according to the identity plane.
 *
 * A LABEL, never an admission: those rows come from the IdP and the
 * collaboration server, which ADR-0215 does not trust to decide who reaches
 * the agent. The owner still approves; this only tells them which request is
 * probably theirs.
 */
export async function bindRequestMatchesOwner(
  request: Pick<FeishuPrincipalBindRequestRow, "tenantKey" | "unionId">,
  owner: SignedInOwner,
  find: typeof findUserIdByExternalIdentity = findUserIdByExternalIdentity
): Promise<boolean> {
  if (!request.tenantKey || !request.unionId) return false
  const linked = await find("lark", request.unionId, request.tenantKey)
  return linked !== undefined && (linked === owner.userId || owner.legacyUserIds.includes(linked))
}
