/**
 * Lark tenant_key backfill.
 *
 * The `/bot/v3/info` whoami probe cannot return the bot's tenant, so
 * `adapterInstances.lastWhoamiResult.tenantKey` starts undefined. The first
 * real inbound event carries a `tenant_key` (on the 2.0 header, or nested under
 * the sender/reader), which is the only signal that identifies which tenant a
 * cross-tenant (external-group) sender belongs to. This module records it once.
 *
 * Kept as a standalone, dependency-injected function so the guard logic is unit
 * testable without driving the whole adapter transport.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { LarkEventEnvelope } from "./parse"
import { extractTenantKey } from "./parse"

interface TenantKeyBackfillDeps {
  getAdapterInstance: (id: string) => Promise<AdapterInstanceRow | undefined>
  updateAdapterInstance: (
    id: string,
    patch: Partial<Pick<AdapterInstanceRow, "lastWhoamiResult">>
  ) => Promise<unknown>
}

/**
 * Record `lastWhoamiResult.tenantKey` from an inbound envelope.
 *
 * Returns `true` once the backfill is settled — written, or already present —
 * so the caller can stop calling. Returns `false` to retry on a later event
 * (this envelope carried no `tenant_key`, or the whoami identity row has not
 * been persisted yet). Never throws for the "nothing to do" cases; only a
 * genuine Dexie read/write failure propagates (the caller swallows it).
 */
export async function applyTenantKeyBackfill(
  adapterId: string,
  envelope: LarkEventEnvelope,
  deps: TenantKeyBackfillDeps
): Promise<boolean> {
  const tenantKey = extractTenantKey(envelope)
  if (!tenantKey) return false // no signal on this envelope — try a later one

  const row = await deps.getAdapterInstance(adapterId)
  const whoami = row?.lastWhoamiResult
  if (!whoami) return false // identity row not persisted yet — retry later
  if (whoami.tenantKey) return true // already recorded — nothing to do

  await deps.updateAdapterInstance(adapterId, {
    lastWhoamiResult: { ...whoami, tenantKey },
  })
  return true
}
