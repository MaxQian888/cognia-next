/**
 * CRUD layer for the `adapterInstances` Dexie table (schema v18).
 *
 * One row per configured adapter instance (one Telegram bot, one Discord
 * guild connection, etc.). Rows are keyed by a generated id; the `type`
 * and `enabled` columns are indexed for the bus boot list.
 */

import type { AdapterInstanceRow } from "./connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getDb } from "./schema"

function newId(): string {
  return "cai_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type AdapterInstanceInput = Omit<AdapterInstanceRow, "id" | "createdAt" | "updatedAt">

export async function createAdapterInstance(
  input: AdapterInstanceInput
): Promise<AdapterInstanceRow> {
  const now = Date.now()
  const row: AdapterInstanceRow = {
    id: newId(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().adapterInstances.add(row)
  return row
}

export async function getAdapterInstance(id: string): Promise<AdapterInstanceRow | undefined> {
  return getDb().adapterInstances.get(id)
}

export async function listAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb().adapterInstances.orderBy("displayName").toArray()
}

export async function listEnabledAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb()
    .adapterInstances.filter((r) => r.enabled)
    .toArray()
}

export async function listAdapterInstancesByType(
  type: PlatformKind
): Promise<AdapterInstanceRow[]> {
  return getDb().adapterInstances.where("type").equals(type).toArray()
}

export type AdapterInstancePatch = Partial<
  Pick<
    AdapterInstanceRow,
    | "displayName"
    | "enabled"
    | "transportMode"
    | "settings"
    | "credentialsRef"
    | "trigger"
    | "defaultCharacterId"
    | "defaultMode"
    | "webhookPath"
    | "publicUrl"
    | "quietHours"
    | "muted"
    | "lastKnownCapabilities"
    | "implMetadata"
    // v45 (im-refactored-crayon) — Lark guardrails + whoami cache.
    | "atResponseStrategy"
    | "inboundActivationPolicy"
    | "activeRunDispatchMode"
    | "activationTtlMs"
    | "deliveryReadiness"
    | "chatAllowlist"
    | "chatBlocklist"
    | "lastWhoamiAt"
    | "lastWhoamiResult"
    | "userTokenStoredAt"
    // Cross-provider help / welcome card settings.
    | "welcomeCardEnabled"
    | "helpTriggers"
    | "welcomeText"
    // In-chat control-command permission gate (control-plane).
    | "controlCommands"
    // Token-usage presence config + runner state (usage-status-runner and
    // the UsagePresence settings form already write these — the whitelist
    // had silently lagged, tripping tsc at both call sites).
    | "presence"
    | "presenceState"
    // v106 (W1 multi-bot) — instance-level AI binding defaults.
    | "defaultTeamId"
    | "defaultWorkflowId"
    | "defaultModel"
    | "defaultProvider"
    | "defaultReasoning"
    | "builtInSkillCeiling"
    | "hostCapabilityCeiling"
    | "requireHitlForWrites"
    // v106 (W2 chat management) — scopes observed missing at runtime.
    | "lastMissingScopes"
    // v107 (W3 multi-bot) — declarative inbound dispatch rules.
    | "dispatchRules"
    // W5 (multi-bot same-group) — sibling-bot inbound guard.
    | "siblingBotPolicy"
    | "botInterplayBudget"
    // Multi-bot outbound: per-bot throttle/breaker tuning + circuit-open
    // failover targets (settings OutboundTuning card).
    | "outboundTuning"
    | "failoverAdapterIds"
    // Multi-bot outbound: rate-limit spillover targets (load balancing).
    | "balanceAdapterIds"
  >
>

export async function updateAdapterInstance(
  id: string,
  patch: AdapterInstancePatch
): Promise<void> {
  await getDb().adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
}

export type AdapterConfigSection =
  "connection" | "behavior" | "responder" | "permissions" | "delivery" | "platform" | "promotion"

export type AdapterConfigSource =
  | "settings"
  | "settings.adapter.behavior"
  | "settings.adapter.permissions"
  | "settings.adapter.responder"
  | "conversation-promotion"
  | "mobile"

/** Atomically persist one settings section and its redaction-safe audit breadcrumb. */
export async function updateAdapterConfigSection(
  id: string,
  section: AdapterConfigSection,
  patch: AdapterInstancePatch,
  source: AdapterConfigSource = "settings"
): Promise<void> {
  const db = getDb()
  const changedKeys = Object.keys(patch).sort()
  if (changedKeys.length === 0) return
  await db.transaction("rw", db.adapterInstances, db.connectorAudit, async () => {
    const updated = await db.adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
    if (updated === 0) throw new Error(`Adapter instance not found: ${id}`)
    await db.connectorAudit.add({
      id: crypto.randomUUID(),
      adapterId: id,
      kind: "adapter.config_changed",
      at: Date.now(),
      fields: { scope: "adapter", section, changedKeys, source },
    })
  })
}

/**
 * Atomically merge adapter settings against the latest stored row.
 *
 * Settings cards often issue several fire-and-forget field updates before a
 * live query rerenders. Reading outside the transaction would let each update
 * merge against the same stale snapshot and silently discard its siblings.
 */
export async function patchAdapterInstanceSettings(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.adapterInstances, async () => {
    const current = await db.adapterInstances.get(id)
    if (!current) return
    await db.adapterInstances.update(id, {
      settings: { ...(current.settings ?? {}), ...patch },
      updatedAt: Date.now(),
    })
  })
}

export async function deleteAdapterInstance(id: string): Promise<void> {
  const db = getDb()
  await db.adapterInstances.delete(id)
  // v51 — Heartbeats live in their own `connectorHeartbeats` table whose only
  // bound is the per-adapter 48h retention sweep inside `recordHeartbeatNow`,
  // which runs ONLY while the adapter is running. A deleted adapter never
  // heartbeats again, so without this reap its rows leak forever (the old
  // global 5000-row audit cap that used to evict them is gone). Best-effort:
  // a cleanup failure must not block the delete itself.
  try {
    await db.connectorHeartbeats.where("adapterId").equals(id).delete()
  } catch {
    // Stale schema (table missing) or transient error — ignore.
  }
}
