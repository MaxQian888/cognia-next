import type {
  IntegrationAccount,
  IntegrationAccountInput,
  IntegrationActionJob,
  IntegrationAuditEntry,
  IntegrationEventEnvelope,
  IntegrationIngressEndpoint,
  IntegrationSubscription,
  IntegrationSubscriptionInput,
} from "@/types/plugin/plugin-integration"
import {
  validateOutboundRecipientGrants,
  type OutboundRecipientGrant,
} from "@cognia/agent-config-types/action-review"
import Dexie from "dexie"
import { getDb } from "./schema"
import {
  INTEGRATION_PROJECTION_STEPS,
  type IntegrationAccountRow,
  type IntegrationEventProjectionV1,
  type IntegrationEventRow,
} from "./integration-types"
import {
  listServiceConnections,
  putServiceConnection,
  removeServiceConnection,
} from "./external-services"
import { listExternalCapabilities, listExternalServices } from "@/lib/external-services/catalog"
import { sha256Hex } from "@/lib/share/hash"

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeApprovedOrigins(origins?: string[]): string[] | undefined {
  if (!origins) return undefined
  return [
    ...new Set(
      origins.map((origin) => {
        const url = new URL(origin)
        if (url.protocol !== "https:") {
          throw new Error(`Integration self-hosted origin "${url.origin}" must use HTTPS`)
        }
        return url.origin
      })
    ),
  ]
}

async function projectIntegrationAccount(account: IntegrationAccount): Promise<void> {
  const services = listExternalServices(account.pluginId)
  for (const service of services) {
    for (const provider of service.definition.providers) {
      if (provider.kind !== "integration" || provider.contributionId !== account.integrationId) {
        continue
      }
      const capabilities = listExternalCapabilities({
        pluginId: account.pluginId,
        serviceId: service.definition.id,
        providerId: provider.id,
      }).map((capability) => ({
        capabilityId: capability.capabilityId,
        operationId: capability.operationId,
        risk: capability.risk,
        inputSchema: capability.inputSchema,
      }))
      const providerFingerprint = await sha256Hex(
        JSON.stringify({
          providerId: account.providerId,
          approvedOrigins: account.approvedOrigins ?? [],
          capabilities,
        })
      )
      const id = `integration:${account.id}:${service.definition.id}:${provider.id}`
      const existing = await getDb().serviceConnections.get(id)
      await putServiceConnection({
        id,
        pluginId: account.pluginId,
        serviceId: service.definition.id,
        providerId: provider.id,
        runtimeTargetId: "local",
        accountLabel: account.label,
        status: !account.enabled
          ? "suspended"
          : account.health === "revoked"
            ? "needs-auth"
            : "connected",
        providerFingerprint,
        providerRef: { kind: "integration", accountId: account.id },
        enabledSurfaces: existing?.enabledSurfaces ?? provider.surfaces,
        createdAt: existing?.createdAt ?? account.createdAt,
        updatedAt: account.updatedAt,
      })
    }
  }
}

export async function reprojectIntegrationAccountsForPlugin(pluginId: string): Promise<number> {
  const accounts = await getDb().integrationAccounts.where("pluginId").equals(pluginId).toArray()
  await Promise.all(accounts.map(projectIntegrationAccount))
  return accounts.length
}

export async function createIntegrationAccount(
  pluginId: string,
  input: IntegrationAccountInput
): Promise<IntegrationAccount> {
  const now = nowIso()
  const row: IntegrationAccount = {
    id: crypto.randomUUID(),
    pluginId,
    integrationId: input.integrationId,
    providerId: input.providerId,
    authSessionId: input.authSessionId,
    remoteAccountId: input.remoteAccountId,
    approvedOrigins: normalizeApprovedOrigins(input.approvedOrigins),
    label: input.label,
    enabled: input.enabled ?? true,
    health: "unknown",
    dedicatedAppConfirmed: input.dedicatedAppConfirmed,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().integrationAccounts.add(row)
  try {
    await projectIntegrationAccount(row)
  } catch (error) {
    await getDb().integrationAccounts.delete(row.id)
    throw error
  }
  return row
}

export async function listIntegrationAccounts(
  pluginId: string,
  integrationId?: string
): Promise<IntegrationAccountRow[]> {
  const rows = integrationId
    ? await getDb()
        .integrationAccounts.where("[pluginId+integrationId]")
        .equals([pluginId, integrationId])
        .toArray()
    : await getDb().integrationAccounts.where("pluginId").equals(pluginId).toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Every integration account on this device, optionally narrowed to one
 * integration.
 *
 * Deliberately without a plugin id, unlike {@link listIntegrationAccounts}. The
 * caller that needs this is a credential picker: a slot names an INTEGRATION
 * (`github-delivery`), and the account that satisfies it may well have been
 * created by a plugin other than the one asking.
 *
 * A full-table read on purpose. `integrationId` on its own is not an index,
 * and adding one would reset every existing database (`CURRENT_SCHEMA_VERSION`
 * only upgrades upward) to speed up a list a person opens by hand.
 */
export async function listAllIntegrationAccounts(
  filter: { integrationId?: string } = {}
): Promise<IntegrationAccountRow[]> {
  const rows = await getDb().integrationAccounts.toArray()
  const visible = filter.integrationId
    ? rows.filter((row) => row.integrationId === filter.integrationId)
    : rows
  return visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getIntegrationAccount(
  pluginId: string,
  accountId: string
): Promise<IntegrationAccountRow | undefined> {
  const row = await getDb().integrationAccounts.get(accountId)
  return row?.pluginId === pluginId ? row : undefined
}

export async function updateIntegrationAccount(
  pluginId: string,
  accountId: string,
  patch: Partial<
    Pick<
      IntegrationAccount,
      "label" | "enabled" | "health" | "status" | "ingressEndpoint" | "dedicatedAppConfirmed"
    >
  >
): Promise<IntegrationAccountRow> {
  const existing = await getIntegrationAccount(pluginId, accountId)
  if (!existing) throw new Error(`Integration account "${accountId}" was not found`)
  const row = { ...existing, ...withoutRecipientList(patch), updatedAt: nowIso() }
  await getDb().integrationAccounts.put(row)
  await projectIntegrationAccount(row)
  return row
}

/**
 * The recipient list has its own writer
 * ({@link setIntegrationAccountOutboundRecipients}). The type keeps it out of a
 * patch; a caller that casts past it (a plugin's `updateAccount` passes
 * whatever it is handed) is not a person either.
 */
function withoutRecipientList<T extends object>(patch: T): T {
  if (!("outboundRecipients" in patch)) return patch
  const { outboundRecipients: _dropped, ...rest } = patch as T & { outboundRecipients?: unknown }
  return rest as T
}

/**
 * Replace the repositories any unattended write through this account may reach
 * (ADR-0239 phase 2): the account's `policy` grant, `integration-account:<id>`.
 * Called only from a person's edit in the integration hub. Every entry is a
 * GitHub repository; an empty list grants nothing.
 */
export async function setIntegrationAccountOutboundRecipients(
  pluginId: string,
  accountId: string,
  recipients: readonly OutboundRecipientGrant[]
): Promise<IntegrationAccountRow> {
  const errors = validateOutboundRecipientGrants(recipients)
  if (errors.length > 0) throw new Error(`Invalid outbound recipients: ${errors.join("; ")}`)
  for (const grant of recipients) {
    if (grant.recipient.kind !== "repository" || grant.recipient.channel !== "github") {
      throw new Error(
        `Invalid outbound recipients: ${grant.recipient.recipient} is not a GitHub repository`
      )
    }
  }
  const db = getDb()
  return db.transaction("rw", db.integrationAccounts, async () => {
    const existing = await getIntegrationAccount(pluginId, accountId)
    if (!existing) throw new Error(`Integration account "${accountId}" was not found`)
    const row: IntegrationAccountRow = {
      ...existing,
      outboundRecipients: recipients.map((grant) => ({
        ...grant,
        recipient: { ...grant.recipient },
      })),
      updatedAt: nowIso(),
    }
    await db.integrationAccounts.put(row)
    return row
  })
}

export async function removeIntegrationAccount(pluginId: string, accountId: string): Promise<void> {
  const existing = await getIntegrationAccount(pluginId, accountId)
  if (!existing) return
  const db = getDb()
  const connections = (await listServiceConnections({ pluginId })).filter(
    (connection) =>
      connection.providerRef.kind === "integration" &&
      connection.providerRef.accountId === accountId
  )
  await db.transaction(
    "rw",
    [
      db.integrationAccounts,
      db.integrationSubscriptions,
      db.integrationEvents,
      db.integrationActionJobs,
    ],
    async () => {
      await db.integrationAccounts.delete(accountId)
      await db.integrationSubscriptions.where("accountId").equals(accountId).delete()
      await db.integrationEvents.where("accountId").equals(accountId).delete()
      await db.integrationActionJobs.where("accountId").equals(accountId).delete()
    }
  )
  await Promise.all(connections.map((connection) => removeServiceConnection(connection.id)))
}

export async function getIntegrationIngressEndpoint(
  pluginId: string,
  accountId: string
): Promise<IntegrationIngressEndpoint | undefined> {
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account) return undefined
  if (account.ingressEndpoint) return account.ingressEndpoint
  const legacy = await getDb()
    .integrationSubscriptions.where("accountId")
    .equals(accountId)
    .filter(
      (subscription) =>
        subscription.pluginId === pluginId &&
        Boolean(subscription.ingressRouteId && subscription.ingressSecretHandle)
    )
    .first()
  if (!legacy?.ingressRouteId || !legacy.ingressSecretHandle) return undefined
  const endpoint: IntegrationIngressEndpoint = {
    id: crypto.randomUUID(),
    accountId,
    routeId: legacy.ingressRouteId,
    secretHandle: legacy.ingressSecretHandle,
    enabled: legacy.enabled,
    createdAt: legacy.createdAt,
    updatedAt: nowIso(),
  }
  await updateIntegrationAccount(pluginId, accountId, { ingressEndpoint: endpoint })
  return endpoint
}

export async function ensureIntegrationIngressEndpoint(
  pluginId: string,
  accountId: string,
  secretHandle: string
): Promise<IntegrationIngressEndpoint> {
  const existing = await getIntegrationIngressEndpoint(pluginId, accountId)
  if (existing) return existing
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account) throw new Error(`Integration account "${accountId}" was not found`)
  const now = nowIso()
  const endpoint: IntegrationIngressEndpoint = {
    id: crypto.randomUUID(),
    accountId,
    routeId: crypto.randomUUID(),
    secretHandle,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  await updateIntegrationAccount(pluginId, accountId, { ingressEndpoint: endpoint })
  return endpoint
}

export async function createIntegrationSubscription(
  pluginId: string,
  input: IntegrationSubscriptionInput
): Promise<IntegrationSubscription> {
  const account = await getIntegrationAccount(pluginId, input.accountId)
  if (!account || account.integrationId !== input.integrationId) {
    throw new Error(`Integration account "${input.accountId}" does not belong to this integration`)
  }
  const now = nowIso()
  const endpoint = input.ingressSecretHandle
    ? await ensureIntegrationIngressEndpoint(pluginId, input.accountId, input.ingressSecretHandle)
    : undefined
  const row: IntegrationSubscription = {
    id: crypto.randomUUID(),
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    eventTypes: [...new Set(input.eventTypes)].sort(),
    inboxProjectionId: input.inboxProjectionId,
    ingressRouteId: endpoint?.routeId,
    ingressSecretHandle: endpoint?.secretHandle,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().integrationSubscriptions.add(row)
  return row
}

export async function listIntegrationSubscriptions(
  pluginId: string,
  accountId?: string
): Promise<IntegrationSubscription[]> {
  const rows = accountId
    ? await getDb().integrationSubscriptions.where("accountId").equals(accountId).toArray()
    : await getDb().integrationSubscriptions.where("pluginId").equals(pluginId).toArray()
  return rows
    .filter((row) => row.pluginId === pluginId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function updateIntegrationSubscription(
  pluginId: string,
  subscriptionId: string,
  patch: Partial<
    Pick<
      IntegrationSubscription,
      "enabled" | "disabledByProvider" | "disabledReason" | "inboxProjectionId" | "eventTypes"
    >
  >
): Promise<IntegrationSubscription> {
  const existing = await getDb().integrationSubscriptions.get(subscriptionId)
  if (!existing || existing.pluginId !== pluginId) {
    throw new Error(`Integration subscription "${subscriptionId}" was not found`)
  }
  const row = { ...existing, ...patch, updatedAt: nowIso() }
  await getDb().integrationSubscriptions.put(row)
  return row
}

export async function removeIntegrationSubscription(
  pluginId: string,
  subscriptionId: string
): Promise<void> {
  const row = await getDb().integrationSubscriptions.get(subscriptionId)
  if (row?.pluginId === pluginId) await getDb().integrationSubscriptions.delete(subscriptionId)
}

/** How long a claimed projection is held before recovery may take it over. */
export const INTEGRATION_PROJECTION_LEASE_MS = 2 * 60 * 1000
/** Attempts before an event's unfinished projections are deadlettered. */
export const INTEGRATION_PROJECTION_MAX_ATTEMPTS = 5
const INTEGRATION_PROJECTION_BASE_BACKOFF_MS = 30_000

function pendingProjection(): IntegrationEventProjectionV1 {
  return {
    version: 1,
    steps: Object.fromEntries(
      INTEGRATION_PROJECTION_STEPS.map((step) => [step, { status: "pending" }])
    ) as IntegrationEventProjectionV1["steps"],
  }
}

export type InsertIntegrationEventResult =
  { inserted: true; row: IntegrationEventRow } | { inserted: false; row: IntegrationEventRow }

/**
 * Store an event once per `[accountId+deliveryId]`.
 *
 * A new row is written already claimed: pending, with its due time one lease
 * ahead, so the caller projects it now and recovery only takes it over if the
 * caller dies before recording the outcome.
 */
export async function insertIntegrationEvent(
  event: IntegrationEventEnvelope,
  now = Date.now()
): Promise<InsertIntegrationEventResult> {
  const db = getDb()
  return db.transaction("rw", db.integrationEvents, async () => {
    const existing = await db.integrationEvents
      .where("[accountId+deliveryId]")
      .equals([event.accountId, event.deliveryId])
      .first()
    if (existing) return { inserted: false as const, row: existing }
    const row: IntegrationEventRow = {
      ...event,
      projection: pendingProjection(),
      projectionState: "pending",
      projectionDueAt: now + INTEGRATION_PROJECTION_LEASE_MS,
      projectionAttempts: 0,
    }
    await db.integrationEvents.add(row)
    return { inserted: true as const, row }
  })
}

/**
 * Take the projection lease on a stored event, or `undefined` when it is
 * finished, deadlettered, legacy, or still leased by another pass. The check
 * and the lease write share one transaction, so two recoverers (or a
 * redelivery racing recovery) never project the same event at once.
 */
export async function claimIntegrationEventProjection(
  eventId: string,
  now = Date.now()
): Promise<IntegrationEventRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.integrationEvents, async () => {
    const row = await db.integrationEvents.get(eventId)
    if (!row || row.projectionState !== "pending") return undefined
    if ((row.projectionDueAt ?? 0) > now) return undefined
    const claimed = { ...row, projectionDueAt: now + INTEGRATION_PROJECTION_LEASE_MS }
    await db.integrationEvents.put(claimed)
    return claimed
  })
}

/**
 * Record one projection pass. All steps complete settles the row; otherwise
 * the attempt is charged and the row comes due again on an exponential
 * backoff, until the attempts run out and it is deadlettered.
 */
export async function recordIntegrationEventProjection(
  eventId: string,
  steps: IntegrationEventProjectionV1["steps"],
  now = Date.now()
): Promise<IntegrationEventRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.integrationEvents, async () => {
    const row = await db.integrationEvents.get(eventId)
    if (!row) return undefined
    const complete = INTEGRATION_PROJECTION_STEPS.every((step) => steps[step].status === "complete")
    const attempts = (row.projectionAttempts ?? 0) + (complete ? 0 : 1)
    const next: IntegrationEventRow = {
      ...row,
      projection: { version: 1, steps },
      projectionAttempts: attempts,
    }
    if (complete) {
      next.projectionState = "complete"
      delete next.projectionDueAt
    } else if (attempts >= INTEGRATION_PROJECTION_MAX_ATTEMPTS) {
      next.projectionState = "deadletter"
      delete next.projectionDueAt
    } else {
      next.projectionState = "pending"
      next.projectionDueAt = now + INTEGRATION_PROJECTION_BASE_BACKOFF_MS * 2 ** (attempts - 1)
    }
    await db.integrationEvents.put(next)
    return next
  })
}

/** Pending events whose due time has passed, oldest due first. */
export async function listDueIntegrationEventProjections(
  now = Date.now(),
  limit = 100
): Promise<IntegrationEventRow[]> {
  return getDb()
    .integrationEvents.where("[projectionState+projectionDueAt]")
    .between(["pending", Dexie.minKey], ["pending", now], true, true)
    .limit(limit)
    .toArray()
}

export type NewIntegrationActionJob = Omit<IntegrationActionJob, "id" | "createdAt" | "updatedAt">

/** The job an account already has for this idempotency key, if any. */
export async function findIntegrationActionJobByIdempotencyKey(
  accountId: string,
  idempotencyKey: string
): Promise<IntegrationActionJob | undefined> {
  return getDb()
    .integrationActionJobs.where("[accountId+idempotencyKey]")
    .equals([accountId, idempotencyKey])
    .first()
}

export async function enqueueIntegrationActionJob(
  input: NewIntegrationActionJob
): Promise<IntegrationActionJob> {
  if (input.idempotencyKey) {
    const existing = await findIntegrationActionJobByIdempotencyKey(
      input.accountId,
      input.idempotencyKey
    )
    if (existing) return existing
  }
  const now = nowIso()
  const row: IntegrationActionJob = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
  await getDb().integrationActionJobs.add(row)
  return row
}

export async function getIntegrationActionJob(
  jobId: string
): Promise<IntegrationActionJob | undefined> {
  return getDb().integrationActionJobs.get(jobId)
}

export async function updateIntegrationActionJob(
  jobId: string,
  patch: Partial<Omit<IntegrationActionJob, "id" | "pluginId" | "createdAt">>
): Promise<IntegrationActionJob> {
  const existing = await getDb().integrationActionJobs.get(jobId)
  if (!existing) throw new Error(`Integration action job "${jobId}" was not found`)
  const row = { ...existing, ...patch, updatedAt: nowIso() }
  await getDb().integrationActionJobs.put(row)
  return row
}

export async function listRunnableIntegrationActionJobs(
  now = nowIso()
): Promise<IntegrationActionJob[]> {
  const queued = await getDb().integrationActionJobs.where("status").equals("queued").toArray()
  const retries = await getDb()
    .integrationActionJobs.where("status")
    .equals("retry_wait")
    .filter((row) => !row.nextAttemptAt || row.nextAttemptAt <= now)
    .toArray()
  return [...queued, ...retries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function listIntegrationActionJobs(): Promise<IntegrationActionJob[]> {
  return (await getDb().integrationActionJobs.toArray()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
}

export async function listIntegrationAudit(pluginId?: string): Promise<IntegrationAuditEntry[]> {
  const rows = pluginId
    ? await getDb().integrationAudit.where("pluginId").equals(pluginId).toArray()
    : await getDb().integrationAudit.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function appendIntegrationAudit(
  input: Omit<IntegrationAuditEntry, "id" | "createdAt">
): Promise<IntegrationAuditEntry> {
  const row: IntegrationAuditEntry = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: nowIso(),
  }
  await getDb().integrationAudit.add(row)
  return row
}

export async function pruneIntegrationRetention(now = Date.now()): Promise<{
  events: number
  audit: number
}> {
  const eventCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const auditCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString()
  // An event with an unfinished projection is still owed to a consumer; age
  // alone never drops it before recovery settles or deadletters it.
  const events = await getDb()
    .integrationEvents.where("receivedAt")
    .below(eventCutoff)
    .filter((row) => row.projectionState !== "pending")
    .delete()
  const audit = await getDb().integrationAudit.where("createdAt").below(auditCutoff).delete()
  return { events, audit }
}
