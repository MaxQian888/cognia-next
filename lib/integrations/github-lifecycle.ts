import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import {
  getIntegrationAccount,
  listIntegrationSubscriptions,
  updateIntegrationAccount,
  updateIntegrationSubscription,
} from "@/lib/db/integrations"

function repositoryNames(payload: unknown, key: string): Set<string> {
  if (!payload || typeof payload !== "object") return new Set()
  const value = (payload as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return new Set()
  return new Set(
    value.flatMap((repository) => {
      if (!repository || typeof repository !== "object") return []
      const name = (repository as { full_name?: unknown }).full_name
      return typeof name === "string" ? [name] : []
    })
  )
}

export async function reconcileGithubLifecycle(event: IntegrationEventEnvelope): Promise<void> {
  if (event.pluginId !== "github-delivery" || event.integrationId !== "github") return
  if (
    !event.eventType.startsWith("installation.") &&
    !event.eventType.startsWith("installation_repositories.") &&
    event.eventType !== "github_app_authorization.revoked"
  ) {
    return
  }
  const account = await getIntegrationAccount(event.pluginId, event.accountId)
  if (!account) return
  const subscriptions = await listIntegrationSubscriptions(event.pluginId, event.accountId)
  const checkedAt = new Date().toISOString()

  if (
    event.eventType === "installation.deleted" ||
    event.eventType === "github_app_authorization.revoked"
  ) {
    await updateIntegrationAccount(event.pluginId, event.accountId, {
      health: "revoked",
      status: {
        health: "revoked",
        code: "installation_revoked",
        message: "GitHub App installation access was revoked",
        checkedAt,
        recoveryAction: "reauthorize",
      },
    })
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.enabled)
        .map((subscription) =>
          updateIntegrationSubscription(event.pluginId, subscription.id, {
            enabled: false,
            disabledByProvider: true,
            disabledReason: "installation_revoked",
          })
        )
    )
    return
  }

  if (event.eventType === "installation.suspend") {
    await updateIntegrationAccount(event.pluginId, event.accountId, {
      health: "degraded",
      status: {
        health: "degraded",
        code: "installation_suspended",
        message: "GitHub App installation is suspended",
        checkedAt,
        recoveryAction: "reconnect",
      },
    })
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.enabled)
        .map((subscription) =>
          updateIntegrationSubscription(event.pluginId, subscription.id, {
            enabled: false,
            disabledByProvider: true,
            disabledReason: "installation_suspended",
          })
        )
    )
    return
  }

  if (
    event.eventType === "installation.unsuspend" ||
    event.eventType === "installation.new_permissions_accepted"
  ) {
    await updateIntegrationAccount(event.pluginId, event.accountId, {
      health: "healthy",
      status: {
        health: "healthy",
        checkedAt,
        lastHealthyAt: checkedAt,
        lastSyncAt: checkedAt,
      },
    })
    await Promise.all(
      subscriptions
        .filter(
          (subscription) =>
            subscription.disabledByProvider &&
            subscription.disabledReason === "installation_suspended"
        )
        .map((subscription) =>
          updateIntegrationSubscription(event.pluginId, subscription.id, {
            enabled: true,
            disabledByProvider: false,
            disabledReason: undefined,
          })
        )
    )
    return
  }

  const removed = repositoryNames(event.payload, "repositories_removed")
  if (event.eventType === "installation_repositories.removed" && removed.size > 0) {
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.resourceId && removed.has(subscription.resourceId))
        .map((subscription) =>
          updateIntegrationSubscription(event.pluginId, subscription.id, {
            enabled: false,
            disabledByProvider: true,
            disabledReason: "repository_removed",
          })
        )
    )
  }

  const added = repositoryNames(event.payload, "repositories_added")
  if (event.eventType === "installation_repositories.added" && added.size > 0) {
    await Promise.all(
      subscriptions
        .filter(
          (subscription) =>
            subscription.disabledByProvider &&
            subscription.disabledReason === "repository_removed" &&
            Boolean(subscription.resourceId && added.has(subscription.resourceId))
        )
        .map((subscription) =>
          updateIntegrationSubscription(event.pluginId, subscription.id, {
            enabled: true,
            disabledByProvider: false,
            disabledReason: undefined,
          })
        )
    )
  }

  await updateIntegrationAccount(event.pluginId, event.accountId, {
    status: {
      ...(account.status ?? { health: account.health, checkedAt }),
      checkedAt,
      lastSyncAt: checkedAt,
    },
  })
}
