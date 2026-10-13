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
import { recordTombstones } from "@/lib/sync/tombstones"
import { assertRunsHere, isOwnedElsewhere } from "@/lib/placement/ownership"
import { hostAdapterInstanceWriter as hostWriter } from "./adapter-instance-remote-writer"
import type { ItemOwner } from "@/types/placement/item-owner"

function newId(): string {
  return "cai_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * `mediaModelPolicy` is optional on the way in and required on the row: this
 * function is the single place the default is applied, so a caller that forgets
 * it gets the safe value rather than an instance with no policy at all.
 */
export type AdapterInstanceInput = Omit<
  AdapterInstanceRow,
  // `owner` has its own writer, `setAdapterInstanceOwner`.
  "id" | "createdAt" | "updatedAt" | "mediaModelPolicy" | "owner"
> & { mediaModelPolicy?: AdapterInstanceRow["mediaModelPolicy"] }

export async function createAdapterInstance(
  input: AdapterInstanceInput,
  options: {
    /**
     * Keep an id the instance already has elsewhere. Only an instance moved
     * from another device (ADR-0224) passes one: its keychain entries, Bot
     * bindings and webhook path are all keyed on it.
     */
    id?: string
  } = {}
): Promise<AdapterInstanceRow> {
  const now = Date.now()
  // A copy made from a placeholder row must not arrive as a placeholder.
  const { owner: _owner, ...fields } = input as AdapterInstanceInput & { owner?: ItemOwner }
  const row: AdapterInstanceRow = {
    id: options.id ?? newId(),
    ...fields,
    // Never inherit "may send binaries to a cloud model" implicitly.
    mediaModelPolicy: input.mediaModelPolicy ?? "local_extract_only",
    createdAt: now,
    updatedAt: now,
  }
  const host = hostWriter()
  if (host) {
    const stored: AdapterInstanceRow = { ...row, ...(await host.create(row)) }
    await getDb().adapterInstances.put(stored)
    return stored
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
    // v178 — confirmed platform identity (sibling-bot guard) and the media
    // policy gate. `userTokenStoredAt` was dropped: nothing read it.
    | "selfIdentity"
    | "mediaModelPolicy"
    | "plugin"
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
    // ADR-0009 §3A.3 — bot-wide reply-quoting default (settings
    // ReplyQuotingDefault card).
    | "replyQuoting"
    // Bot-wide A2UI switch (tri-state — see the row's docblock).
    | "a2uiEnabled"
    | "failoverAdapterIds"
    // Multi-bot outbound: rate-limit spillover targets (load balancing).
    | "balanceAdapterIds"
    // Slice 1B — bot-wide response SLA + escalation chain defaults.
    | "defaultSlaResponseMinutes"
    | "defaultEscalation"
    // ADR-0117 — bot-wide composition axes. The row has carried these since
    // the axis model landed, but the whitelist did not, so they could not be
    // written even programmatically: the only values a conversation ever saw
    // were the ones derived from `defaultMode`.
    | "defaultAutonomy"
    | "defaultEngagement"
    | "defaultAuthority"
  >
>

export async function updateAdapterInstance(
  id: string,
  patch: AdapterInstancePatch
): Promise<void> {
  const db = getDb()
  const host = hostWriter()
  if (host) {
    await host.configure(id, patch)
    await db.adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
    return
  }
  await db.transaction("rw", db.adapterInstances, async () => {
    await assertInstanceRunsHere(id)
    await db.adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
  })
}

/**
 * A placeholder records where its instance went (ADR-0224). An edit here would
 * not reach the host, and enabling it would answer the same chats twice.
 */
async function assertInstanceRunsHere(id: string): Promise<void> {
  const row = await getDb().adapterInstances.get(id)
  if (row) assertRunsHere("connector-instance", row.owner)
}

/**
 * Record which machine runs an instance (ADR-0224). The one writer of
 * `owner`; the edit paths refuse a placeholder, so this is also the only way
 * out of one.
 *
 * Moving it to a paired host fences the local row: `enabled: false`, which
 * the live runtime's reconcile turns into a stop. Clearing the owner or
 * pinning it here (take-back, manual pin) restores `options.enabled`.
 */
export async function setAdapterInstanceOwner(
  id: string,
  owner: ItemOwner | undefined,
  options: { enabled?: boolean } = {}
): Promise<AdapterInstanceRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.adapterInstances, async () => {
    const existing = await db.adapterInstances.get(id)
    if (!existing) return undefined
    const next: AdapterInstanceRow = {
      ...existing,
      enabled: isOwnedElsewhere(owner) ? false : (options.enabled ?? existing.enabled),
      updatedAt: Date.now(),
    }
    if (owner) next.owner = owner
    else delete next.owner
    await db.adapterInstances.put(next)
    return next
  })
}

export type AdapterConfigSection =
  | "connection"
  | "behavior"
  /** The inbound trigger policy — when this bot answers and when it stays quiet. */
  | "trigger"
  | "responder"
  | "permissions"
  | "delivery"
  | "platform"
  | "promotion"

export type AdapterConfigSource =
  | "settings"
  | "settings.adapter.behavior"
  | "settings.adapter.trigger"
  | "settings.adapter.permissions"
  | "settings.adapter.responder"
  | "settings.adapter.sla-escalation"
  | "conversation-promotion"
  | "mobile"
  /** Another device of the account configuring this host's instance (ADR-0224). */
  | "paired-device"

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
  const host = hostWriter()
  if (host) {
    // The Host writes the audit breadcrumb with the change it applies.
    await host.configure(id, patch)
    await db.adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
    return
  }
  await db.transaction("rw", db.adapterInstances, db.connectorAudit, async () => {
    await assertInstanceRunsHere(id)
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
  const host = hostWriter()
  if (host) {
    // Merged against the mirror, the freshest copy this shell has; the Host
    // replaces `settings` whole.
    const current = await db.adapterInstances.get(id)
    if (!current) return
    const settings = { ...(current.settings ?? {}), ...patch }
    await host.configure(id, { settings })
    await db.adapterInstances.update(id, { settings, updatedAt: Date.now() })
    return
  }
  await db.transaction("rw", db.adapterInstances, async () => {
    const current = await db.adapterInstances.get(id)
    if (!current) return
    assertRunsHere("connector-instance", current.owner)
    await db.adapterInstances.update(id, {
      settings: { ...(current.settings ?? {}), ...patch },
      updatedAt: Date.now(),
    })
  })
}

export async function deleteAdapterInstance(id: string): Promise<void> {
  const db = getDb()
  const host = hostWriter()
  if (host) {
    // The Host removes the row, its secrets and its tombstone; the mirror only
    // drops its copy.
    await host.remove(id)
    await db.adapterInstances.delete(id)
    return
  }
  await db.transaction("rw", db.adapterInstances, db.syncTombstones, async () => {
    await db.adapterInstances.delete(id)
    // Paired clients mirror `adapterInstances` and hear about a removed
    // connector only through this tombstone.
    await recordTombstones("adapterInstances", [id])
  })
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
