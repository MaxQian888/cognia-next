import type {
  IntegrationAccount,
  IntegrationAccountInput,
  IntegrationActionJob,
  IntegrationAuditEntry,
  IntegrationEventEnvelope,
  IntegrationSubscription,
  IntegrationSubscriptionInput,
} from "@/types/plugin/plugin-integration"
import { getDb } from "./schema"

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
    createdAt: now,
    updatedAt: now,
  }
  await getDb().integrationAccounts.add(row)
  return row
}

export async function listIntegrationAccounts(
  pluginId: string,
  integrationId?: string
): Promise<IntegrationAccount[]> {
  const rows = integrationId
    ? await getDb()
        .integrationAccounts.where("[pluginId+integrationId]")
        .equals([pluginId, integrationId])
        .toArray()
    : await getDb().integrationAccounts.where("pluginId").equals(pluginId).toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getIntegrationAccount(
  pluginId: string,
  accountId: string
): Promise<IntegrationAccount | undefined> {
  const row = await getDb().integrationAccounts.get(accountId)
  return row?.pluginId === pluginId ? row : undefined
}

export async function updateIntegrationAccount(
  pluginId: string,
  accountId: string,
  patch: Partial<Pick<IntegrationAccount, "label" | "enabled" | "health">>
): Promise<IntegrationAccount> {
  const existing = await getIntegrationAccount(pluginId, accountId)
  if (!existing) throw new Error(`Integration account "${accountId}" was not found`)
  const row = { ...existing, ...patch, updatedAt: nowIso() }
  await getDb().integrationAccounts.put(row)
  return row
}

export async function removeIntegrationAccount(pluginId: string, accountId: string): Promise<void> {
  const existing = await getIntegrationAccount(pluginId, accountId)
  if (!existing) return
  const db = getDb()
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
  const row: IntegrationSubscription = {
    id: crypto.randomUUID(),
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    eventTypes: [...new Set(input.eventTypes)].sort(),
    inboxProjectionId: input.inboxProjectionId,
    ingressRouteId: input.ingressSecretHandle ? crypto.randomUUID() : undefined,
    ingressSecretHandle: input.ingressSecretHandle,
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

export async function removeIntegrationSubscription(
  pluginId: string,
  subscriptionId: string
): Promise<void> {
  const row = await getDb().integrationSubscriptions.get(subscriptionId)
  if (row?.pluginId === pluginId) await getDb().integrationSubscriptions.delete(subscriptionId)
}

export async function insertIntegrationEvent(
  event: IntegrationEventEnvelope
): Promise<{ inserted: boolean }> {
  const existing = await getDb()
    .integrationEvents.where("[accountId+deliveryId]")
    .equals([event.accountId, event.deliveryId])
    .first()
  if (existing) return { inserted: false }
  await getDb().integrationEvents.add(event)
  return { inserted: true }
}

export type NewIntegrationActionJob = Omit<IntegrationActionJob, "id" | "createdAt" | "updatedAt">

export async function enqueueIntegrationActionJob(
  input: NewIntegrationActionJob
): Promise<IntegrationActionJob> {
  if (input.idempotencyKey) {
    const existing = await getDb()
      .integrationActionJobs.where("[accountId+idempotencyKey]")
      .equals([input.accountId, input.idempotencyKey])
      .first()
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
  const events = await getDb().integrationEvents.where("receivedAt").below(eventCutoff).delete()
  const audit = await getDb().integrationAudit.where("createdAt").below(auditCutoff).delete()
  return { events, audit }
}
