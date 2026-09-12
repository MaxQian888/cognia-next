import type { PluginBotsAPI } from "@/types/bot/api"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { dispatchManualBotRun } from "@/lib/bot/events/dispatch"
import { botEventId, buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import { getIntegrationIngressEndpoint } from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import { dismissBotDelivery, isTerminalBotDelivery } from "@/lib/db/bot-event-deliveries"
import { cancelBotRun } from "@/lib/bot/runtime/run"

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
      return {
        id: installation.id,
        createdAt: installation.createdAt,
        activatedAt: installation.activatedAt,
        config: {
          ...defaultsFromConfigSchema(resolved.definition.configSchema),
          ...installation.config,
        },
        triggerState: installation.triggerState ?? {},
        monitor: installation.monitor,
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
