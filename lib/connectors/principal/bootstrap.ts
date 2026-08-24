/**
 * First-run seeding for the Feishu principal registry.
 *
 * The registry fails closed: with `larkPrincipalRegistry` on, a sender with no
 * principal row is parked `history_only` and answered with a bind code. That
 * is the correct posture for a NEW workspace, but turning the flag on for a
 * workspace that has been talking to the bot for months would park everyone at
 * once and hand a pile of bind codes to an operator who never asked for them.
 *
 * So the first time the flag is on for an adapter whose tenant is not yet
 * registered, we admit the tenant the adapter itself authenticated as, and
 * bind every Feishu identity the workspace has ALREADY conversed with. Those
 * senders were reaching the agent before this epic; the registry's job is to
 * gate strangers, not to retroactively lock out the existing users.
 *
 * Seeding runs exactly once per (tenantKey, appId): the presence of the tenant
 * row is the marker, so a restart, a re-queue, or a second adapter for the
 * same tenant never re-seeds, and an operator who deliberately disabled a
 * principal never has it silently re-admitted.
 */

import type { AdapterInstanceRow, PlatformIdentityRow } from "@/lib/db/connector-types"
import { createFeishuPrincipal, getFeishuTenant } from "@/lib/db/feishu-principals"
import { getDb } from "@/lib/db/schema"
import { isLarkPrincipalRegistryEnabled } from "../feature-flags"
import { registerFeishuTenant, withDefaults, type PrincipalAdminDependencies } from "./admin"

export type BootstrapSkipReason = "flag_off" | "identity_unknown" | "already_registered"

export type BootstrapRegistryResult =
  | { status: "skipped"; reason: BootstrapSkipReason }
  | { status: "seeded"; tenantId: string; seeded: number; skipped: number }

export interface BootstrapRegistryInput {
  adapterId: string
  adapterRow: Pick<AdapterInstanceRow, "settings" | "lastWhoamiResult">
  accountId?: string
}

export interface BootstrapDependencies extends PrincipalAdminDependencies {
  listIdentities: (adapterId: string) => Promise<PlatformIdentityRow[]>
}

/** Lark identities this adapter has already seen, excluding bots and system. */
async function defaultListIdentities(adapterId: string): Promise<PlatformIdentityRow[]> {
  const rows = await getDb()
    .platformIdentities.where("platform")
    .equals("lark")
    .filter((row) => row.adapterId === adapterId)
    .toArray()
  return rows.filter((row) => row.kind !== "bot" && row.kind !== "system")
}

export async function bootstrapFeishuRegistry(
  input: BootstrapRegistryInput,
  overrides: Partial<BootstrapDependencies> = {}
): Promise<BootstrapRegistryResult> {
  // The shared admin defaults plus this module's own `listIdentities`. Built
  // from `withDefaults` rather than re-listing the fields here: the local copy
  // had drifted and no longer supplied `revokeSessions`.
  const deps: BootstrapDependencies = {
    ...withDefaults(overrides),
    listIdentities: overrides.listIdentities ?? defaultListIdentities,
  }

  if (!isLarkPrincipalRegistryEnabled(input.adapterRow)) {
    return { status: "skipped", reason: "flag_off" }
  }

  const tenantKey = input.adapterRow.lastWhoamiResult?.tenantKey
  const appId = input.adapterRow.lastWhoamiResult?.appId
  // No guessing: without a verified tenant scope, seeding could bind an
  // external-group sender into the home tenant. Wait for the whoami/tenant
  // backfill instead — the next adapter start retries.
  if (!tenantKey || !appId) {
    return { status: "skipped", reason: "identity_unknown" }
  }

  if (await getFeishuTenant(tenantKey, appId)) {
    return { status: "skipped", reason: "already_registered" }
  }

  const accountId = input.accountId ?? deps.activeAccountId()
  const tenant = await registerFeishuTenant(
    { adapterId: input.adapterId, tenantKey, appId, accountId },
    deps
  )

  const selfOpenId = input.adapterRow.lastWhoamiResult?.openId
  const identities = await deps.listIdentities(input.adapterId)
  let seeded = 0
  let skipped = 0
  for (const identity of identities) {
    if (!identity.remoteUserId || identity.remoteUserId === selfOpenId) {
      skipped += 1
      continue
    }
    try {
      await createFeishuPrincipal({
        tenantKey,
        appId,
        openId: identity.remoteUserId,
        cogniaAccountId: accountId,
        cogniaUserId: accountId,
        platformIdentityId: identity.id,
        now: deps.now(),
      })
      seeded += 1
    } catch {
      // Duplicate (tenantKey, appId, openId) — another adapter for the same
      // tenant seeded it, or the directory holds two rows for one person.
      skipped += 1
    }
  }

  // One batch row rather than N: the per-principal decision here is
  // "everyone already in the directory", so the count IS the decision.
  await deps.audit({
    adapterId: input.adapterId,
    kind: "principal.bound",
    at: deps.now(),
    reason: "bootstrap",
    fields: { tenantId: tenant.id, tenantKey, appId, accountId, seeded, skipped },
  })

  return { status: "seeded", tenantId: tenant.id, seeded, skipped }
}
