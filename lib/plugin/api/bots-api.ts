import type { BotPublicationReference, PluginBotsAPI } from "@/types/bot/api"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { dispatchManualBotRun } from "@/lib/bot/events/dispatch"
import { botEventId, buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import { getIntegrationIngressEndpoint } from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import { dismissBotDelivery, isTerminalBotDelivery } from "@/lib/db/bot-event-deliveries"
import { cancelBotRun } from "@/lib/bot/runtime/run"

/** Only the current installation's locally owned host artifacts may restore tracking. */
async function publicationReferences(
  installationId: string,
  repository: unknown
): Promise<BotPublicationReference[]> {
  const db = getDb()
  const references: BotPublicationReference[] = []
  // Walk only primary keys in bounded pages. Poll history still adds cheap index
  // traversal, but never loads poll payloads, results, runs, or deliveries.
  const pageSize = 512
  let after: string | undefined
  while (true) {
    const keys = await (
      after === undefined ? db.botRunSteps.orderBy(":id") : db.botRunSteps.where(":id").above(after)
    )
      .limit(pageSize)
      .primaryKeys()
    if (keys.length === 0) break
    after = keys[keys.length - 1] as string
    const publicationKeys = keys.filter((key) =>
      String(key).includes("::__host:publication:")
    ) as string[]
    const checkpoints = await db.botRunSteps.bulkGet(publicationKeys)
    for (const checkpoint of checkpoints) {
      if (!checkpoint) continue
      const artifact = checkpoint.output as Record<string, unknown> | null | undefined
      if (
        checkpoint.status !== "completed" ||
        !artifact ||
        typeof artifact.repository !== "string" ||
        typeof artifact.branch !== "string" ||
        !artifact.branch ||
        typeof artifact.headSha !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(artifact.headSha) ||
        typeof artifact.snapshotId !== "string" ||
        checkpoint.name !== `__host:publication:${artifact.snapshotId}`
      )
        continue
      if (
        typeof repository === "string" &&
        artifact.repository.toLowerCase() !== repository.toLowerCase()
      )
        continue
      const run = await db.executionRuns.get(checkpoint.runId)
      if (!run || run.kind !== "bot" || run.sourceId !== installationId) continue
      const delivery = await db.botEventDeliveries
        .where("runId")
        .equals(run.id)
        .filter((row) => row.installationId === installationId && !row.syncedFromHost)
        .first()
      if (!delivery) continue
      const snapshot = await db.botRunSteps.get(`${run.id}::__host:snapshot:${artifact.snapshotId}`)
      const snapshotValue = snapshot?.output as { id?: unknown; runId?: unknown } | undefined
      if (
        snapshot?.status !== "completed" ||
        snapshotValue?.id !== artifact.snapshotId ||
        snapshotValue.runId !== run.id
      )
        continue
      references.push({
        sourceRunId: run.id,
        repository: artifact.repository,
        branch: artifact.branch,
        headSha: artifact.headSha,
        snapshotId: artifact.snapshotId,
        sourcePayload: delivery.envelope.payload,
      })
      if (references.length === 256) return references
    }
  }
  return references
}

export function createBotsAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginBotsAPI {
  async function own(runId: string) {
    if (!hasPermission("agent:control")) throw new Error("ctx.bots requires agent:control")
    return requireOwnedBotRun(pluginId, runId)
  }
  return {
    async getInstallation(runId) {
      const { installation, resolved } = await own(runId)
      const db = getDb()
      const accounts = Object.values(installation.credentialBindings).flatMap((binding) =>
        binding.integrationAccountId ? [binding.integrationAccountId] : []
      )
      const subscriptions = await db.integrationSubscriptions.toArray()
      const boundSubscriptions = subscriptions.filter((subscription) =>
        accounts.includes(subscription.accountId)
      )
      const endpoints = await Promise.all(
        boundSubscriptions.map((subscription) =>
          getIntegrationIngressEndpoint(subscription.pluginId, subscription.accountId)
        )
      )
      const config = {
        ...defaultsFromConfigSchema(resolved.definition.configSchema),
        ...installation.config,
      }
      return {
        id: installation.id,
        createdAt: installation.createdAt,
        activatedAt: installation.activatedAt,
        config,
        triggerState: installation.triggerState ?? {},
        monitor: installation.monitor,
        publications: await publicationReferences(installation.id, config.repository),
        webhookEnabled: subscriptions.some(
          (subscription) =>
            accounts.includes(subscription.accountId) &&
            subscription.enabled &&
            endpoints.some(
              (endpoint) => endpoint?.enabled && endpoint.accountId === subscription.accountId
            )
        ),
      }
    },
    async enqueue(runId, input) {
      const { resolved } = await own(runId)
      const trigger = resolved.definition.triggers.find((item) => item.id === input.triggerId)
      if (!trigger || trigger.kind !== "manual")
        throw new Error("Bot child work must name a declared manual trigger")
      if (!input.eventId.trim() || !input.type.trim())
        throw new Error("Bot child event requires an identity and type")
      const envelope = buildBotEventEnvelope({
        source: "bot",
        sourceRecordId: input.eventId,
        type: input.type,
        installationId: resolved.installation.id,
        triggerId: trigger.id,
        occurredAt: Date.now(),
        payload: input.payload,
        ...(input.resource ? { resource: input.resource } : {}),
        provenance: {
          selfProduced: true,
          depth: 1,
          producedByInstallationId: resolved.installation.id,
        },
      })
      if (input.correlation)
        envelope.correlation = `${resolved.installation.id}::${input.correlation}`
      const delivery = await dispatchManualBotRun({ resolved, triggerId: trigger.id, envelope })
      return { deliveryId: delivery.id }
    },
    async cancelResource(runId, input) {
      const { installation } = await own(runId)
      const rows = await getDb()
        .botEventDeliveries.where("installationId")
        .equals(installation.id)
        .toArray()
      const affected = rows.filter(
        (row) =>
          row.runId !== runId &&
          !isTerminalBotDelivery(row.status) &&
          row.envelope.resource?.id === input.resourceId &&
          (!input.exceptRevision ||
            (row.envelope.payload as { revision?: unknown } | null)?.revision !==
              input.exceptRevision) &&
          (!input.exceptEventId || row.eventId !== botEventId("bot", input.exceptEventId))
      )
      for (const row of affected) {
        if (row.runId) {
          await cancelBotRun(row.runId)
        }
        await dismissBotDelivery(row.id, "resource changed or closed")
      }
      return affected.length
    },
    async recordMonitor(runId, patch) {
      const { installation } = await own(runId)
      for (const value of [patch.lastSuccessAt, patch.retryAt]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0))
          throw new Error("Invalid monitor timestamp")
      }
      const db = getDb()
      await db.transaction("rw", db.botInstallations, async () => {
        const current = await db.botInstallations.get(installation.id)
        if (!current) throw new Error("Bot installation was removed")
        await db.botInstallations.update(current.id, {
          monitor: {
            ...current.monitor,
            // JSON/Python callers omit undefined fields. A successful sync
            // clears a previous failure even across that serialized boundary.
            ...(patch.lastSuccessAt !== undefined
              ? { lastError: undefined, retryAt: undefined }
              : {}),
            ...patch,
          },
          updatedAt: Date.now(),
        })
      })
    },
  }
}
