/**
 * The signed-in owner messaging another of their own bots (ADR-0215 §9).
 *
 * The registry fails closed: a sender without a principal is parked and handed
 * a bind code. The owner confirms who they are ONCE, by approving their own
 * bind request "as me" (`approveFeishuBind({ asSignedInOwner: true })`), which
 * stamps `ownerConfirmedAt` on that principal. After that, the same person
 * messaging a different bot app in the same tenant is admitted here instead of
 * being handed another code.
 *
 * # What is trusted, and what is not
 *
 * The owner's confirmation is the only authority. The identity plane's
 * `lark:<tenantKey>:<union_id>` rows come from the IdP and the collaboration
 * server; they may label a bind request as "matches your sign-in", but they
 * never admit anybody (`login-link.ts:bindRequestMatchesOwner`). A server that
 * lies about a union id therefore gains nothing.
 *
 * A sender is admitted only when ALL of these hold:
 *
 *   - the event arrived on a transport that cannot be forged with a static
 *     token: Feishu's long connection, or a webhook signed with an encrypt key.
 *     A webhook checked only against the verification token is refused, since
 *     one forged event would otherwise mint a permanent principal;
 *   - the envelope carried a tenant, an app and the sender's `union_id`;
 *   - the tenant is registered, active, and belongs to the account this
 *     runtime serves;
 *   - the profile is bound to a person (`userBindings`);
 *   - an ACTIVE principal in the same tenant, with the same `union_id`, the
 *     same account and that same person, carries `ownerConfirmedAt`.
 *
 * Principals created here record `selfBoundAt`. They are unlinked when the
 * profile signs out or is taken over by someone else
 * (`login-link.ts:unlinkSelfBoundPrincipals`) and re-activated here when the same person is
 * back. An operator's own disable is never undone.
 */

import type { FeishuPrincipalRow } from "@/lib/db/connector-types"
import type { UserBindingRow } from "@/lib/accounts/account-db"
import type { TransportMode } from "@/types/connectors/adapter"
import { appendAudit } from "@/lib/connectors/audit"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import {
  createFeishuPrincipal,
  getFeishuPrincipal,
  getFeishuTenant,
  listFeishuPrincipalsByUnionId,
  rebindFeishuPrincipal,
  setFeishuPrincipalStatus,
} from "@/lib/db/feishu-principals"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
import { bindLarkIdentityTo } from "./person"
import { hashOpenId, type IdentityScope } from "./resolve"

export type SelfBindSkipReason =
  | "transport_untrusted"
  | "scope_incomplete"
  | "tenant_unknown"
  | "tenant_foreign"
  | "profile_unbound"
  | "not_confirmed"
  | "already_bound"

export type SelfBindResult =
  | { status: "bound"; principal: FeishuPrincipalRow }
  | { status: "skipped"; reason: SelfBindSkipReason }

export interface SelfBindInput {
  adapterId: string
  /** The transports the running adapter declares (`meta.transportModes`). */
  transportModes: readonly TransportMode[] | undefined
  /** Lark open_id of the sender. */
  openId: string
  identityScope?: IdentityScope
  /** The envelope's app id may be absent; the adapter's whoami knows its own. */
  fallbackAppId?: string
  /** The LocalProfile this runtime serves. */
  accountId: string
  conversationKey?: string
}

export interface SelfBindDependencies {
  binding: (localAccountId: string) => Promise<UserBindingRow | null>
  readSecret: (adapterId: string, account: string) => Promise<string | undefined | null>
  audit: typeof appendAudit
  now: () => number
}

function defaultDependencies(): SelfBindDependencies {
  return {
    binding: (localAccountId) => new UserBindingRegistry().get(localAccountId),
    readSecret: connectorsKeyringGet,
    audit: appendAudit,
    now: Date.now,
  }
}

/**
 * Whether the events this adapter receives are authenticated by more than a
 * static token. Unknown is untrusted: a principal is never minted on a guess.
 */
export async function isForgeResistantTransport(
  adapterId: string,
  transportModes: readonly TransportMode[] | undefined,
  readSecret: SelfBindDependencies["readSecret"]
): Promise<boolean> {
  if (!transportModes || transportModes.length !== 1) return false
  const [mode] = transportModes
  // Feishu's long connection is an outbound socket the platform itself
  // authenticates with the app's credentials.
  if (mode === "gateway") return true
  if (mode !== "webhook") return false
  try {
    const encryptKey = await readSecret(adapterId, "encryptKey")
    return typeof encryptKey === "string" && encryptKey.trim().length > 0
  } catch {
    return false
  }
}

function confirmsOwner(
  principal: FeishuPrincipalRow,
  accountId: string,
  ownerIds: ReadonlySet<string>
): boolean {
  return (
    principal.status === "active" &&
    principal.ownerConfirmedAt !== undefined &&
    principal.cogniaAccountId === accountId &&
    ownerIds.has(principal.cogniaUserId)
  )
}

export async function selfBindSignedInOwner(
  input: SelfBindInput,
  overrides: Partial<SelfBindDependencies> = {}
): Promise<SelfBindResult> {
  const deps: SelfBindDependencies = { ...defaultDependencies(), ...overrides }
  const tenantKey = input.identityScope?.tenantKey
  const appId = input.identityScope?.appId ?? input.fallbackAppId
  const unionId = input.identityScope?.unionId
  if (!tenantKey || !appId || !unionId) return { status: "skipped", reason: "scope_incomplete" }

  if (!(await isForgeResistantTransport(input.adapterId, input.transportModes, deps.readSecret))) {
    return { status: "skipped", reason: "transport_untrusted" }
  }

  const tenant = await getFeishuTenant(tenantKey, appId)
  if (!tenant || tenant.status !== "active") return { status: "skipped", reason: "tenant_unknown" }
  if (tenant.cogniaAccountId !== input.accountId) {
    return { status: "skipped", reason: "tenant_foreign" }
  }

  const binding = await deps.binding(input.accountId)
  if (!binding) return { status: "skipped", reason: "profile_unbound" }
  const ownerIds = new Set([binding.userId, ...(binding.legacyUserIds ?? [])])

  const confirmed = (await listFeishuPrincipalsByUnionId(tenantKey, unionId)).some((principal) =>
    confirmsOwner(principal, input.accountId, ownerIds)
  )
  if (!confirmed) return { status: "skipped", reason: "not_confirmed" }

  const now = deps.now()
  const existing = await getFeishuPrincipal(tenantKey, appId, input.openId)
  let principal: FeishuPrincipalRow
  if (existing) {
    // Only a principal this path created and a sign-out unlinked comes back;
    // a disabled one, or one an operator unlinked, is an operator decision.
    if (existing.status !== "unlinked" || existing.selfBoundAt === undefined) {
      return { status: "skipped", reason: "already_bound" }
    }
    if (!ownerIds.has(existing.cogniaUserId) || existing.cogniaAccountId !== input.accountId) {
      return { status: "skipped", reason: "already_bound" }
    }
    await setFeishuPrincipalStatus(existing.id, "active", now)
    principal = await rebindFeishuPrincipal(existing.id, { selfBoundAt: now }, now)
  } else {
    try {
      principal = await createFeishuPrincipal({
        tenantKey,
        appId,
        openId: input.openId,
        unionId,
        cogniaAccountId: input.accountId,
        cogniaUserId: binding.userId,
        logtoSubject: binding.logtoSubject,
        selfBoundAt: now,
        now,
      })
    } catch (error) {
      // Two first messages raced on the unique (tenant, app, open_id) index:
      // the other one created exactly the principal this one would have.
      const raced = await getFeishuPrincipal(tenantKey, appId, input.openId)
      if (raced?.status === "active" && raced.selfBoundAt !== undefined) {
        return { status: "bound", principal: raced }
      }
      throw error
    }
  }

  // Bookkeeping after the decision: a failure here must not turn an admitted
  // owner back into a parked stranger.
  try {
    // This app's open_id names the owner from now on. The union id is not
    // re-filed: it is already the owner's by the confirmation above.
    await bindLarkIdentityTo({
      userId: binding.userId,
      tenantKey,
      appId,
      openId: input.openId,
      ...(binding.displayName ? { displayName: binding.displayName } : {}),
      now,
    })
    await deps.audit({
      adapterId: input.adapterId,
      kind: "principal.bound",
      at: now,
      reason: "signed_in_owner",
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      fields: {
        principalId: principal.id,
        tenantKey,
        appId,
        openIdHash: await hashOpenId(input.openId),
        accountId: input.accountId,
      },
    })
  } catch {
    // The principal stands; the next sighting has nothing left to do.
  }
  return { status: "bound", principal }
}
