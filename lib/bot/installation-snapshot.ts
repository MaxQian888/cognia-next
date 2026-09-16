/**
 * The `BotInstallationSnapshot` projection.
 *
 * Extracted from `ctx.bots.getInstallation` so a second caller — the
 * lifecycle hook runner, which hands a hook the same view of the
 * installation a running handler would see — cannot drift from the API. Two
 * projections would eventually disagree on which fields are secrets: the
 * snapshot deliberately carries bound/not-bound booleans, never the
 * account/session/adapter ids underneath.
 */

import type { BotInstallationSnapshot, BotPublicationReference } from "@/types/bot/api"
import type { ResolvedBotDefinition } from "@/lib/bot/installed-bot"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import { getIntegrationIngressEndpoint } from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import { isBotTriggerArmed } from "@/lib/db/bot-installations"

/** Only the current installation's locally owned host artifacts may restore tracking. */
export async function publicationReferences(
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

/**
 * The snapshot both `ctx.bots.getInstallation` and a lifecycle hook receive.
 * `definition` must be the same installation's resolved definition — callers
 * own that pairing.
 */
export async function projectBotInstallationSnapshot(
  installation: BotInstallationRow,
  definition: ResolvedBotDefinition
): Promise<BotInstallationSnapshot> {
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
    ...defaultsFromConfigSchema(definition.configSchema),
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
    definitionId: installation.definitionId,
    pinnedVersion: installation.pinnedVersion,
    status: installation.status,
    scope: installation.scope,
    triggers: definition.triggers.map((trigger) => ({
      id: trigger.id,
      kind: trigger.kind,
      armed: isBotTriggerArmed(installation, trigger),
    })),
    // Which slots are bound, never WHICH account/session/adapter — those
    // ids are the broker's to resolve, not the handler's to see.
    credentialSlots: (definition.requires?.credentials ?? []).map((slot) => {
      const binding = installation.credentialBindings[slot.id]
      return {
        id: slot.id,
        optional: !!slot.optional,
        bound: Boolean(
          binding?.integrationAccountId || binding?.authSessionId || binding?.adapterId
        ),
      }
    }),
  }
}
