import type {
  IntegrationAccount,
  IntegrationAccountInput,
  IntegrationActionJob,
  IntegrationEventEnvelope,
  IntegrationRequestInit,
  IntegrationSubscription,
  IntegrationSubscriptionInput,
  PluginIntegrationsAPI,
} from "@/types/plugin/plugin-integration"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  getIntegrationActionJob,
  getIntegrationAccount,
  getIntegrationIngressEndpoint,
  listIntegrationAccounts,
  listIntegrationSubscriptions,
  updateIntegrationAccount,
} from "@/lib/db/integrations"
import {
  authenticatedIntegrationRequest,
  cancelIntegrationActionJob,
  executeIntegrationAction,
} from "@/lib/integrations/action-runner"
import { publishIntegrationEvent } from "@/lib/integrations/events"
import {
  migrateLegacyIntegration,
  rollbackIntegrationMigration,
} from "@/lib/integrations/migration"
import { getRegisteredIntegration, listRegisteredIntegrations } from "@/lib/integrations/registry"
import {
  checkIntegrationAccountHealth,
  listIntegrationResources,
} from "@/lib/integrations/providers"

type IntegrationPermission =
  "integrations:read" | "integrations:events" | "integrations:execute" | "integrations:manage"

function requirePermission(
  hasPermission: (permission: string) => boolean,
  permission: IntegrationPermission,
  method: string
): void {
  if (!hasPermission(permission)) {
    throw new Error(`${method} requires the "${permission}" permission`)
  }
}

export function createIntegrationsAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginIntegrationsAPI {
  return {
    listDefinitions() {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listDefinitions")
      return listRegisteredIntegrations(pluginId)
    },
    async listAccounts(integrationId?: string) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listAccounts")
      return listIntegrationAccounts(pluginId, integrationId)
    },
    async createAccount(input: IntegrationAccountInput): Promise<IntegrationAccount> {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.createAccount")
      if (!getRegisteredIntegration(pluginId, input.integrationId)) {
        throw new Error(`Integration "${input.integrationId}" is not registered`)
      }
      return createIntegrationAccount(pluginId, input)
    },
    async updateAccount(accountId, patch) {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.updateAccount")
      return updateIntegrationAccount(pluginId, accountId, patch)
    },
    async removeAccount(accountId) {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.removeAccount")
      const { deleteIntegrationAccount } = await import("@/lib/integrations/ingress-client")
      await deleteIntegrationAccount(pluginId, accountId)
    },
    async listSubscriptions(accountId?: string): Promise<IntegrationSubscription[]> {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listSubscriptions")
      return listIntegrationSubscriptions(pluginId, accountId)
    },
    async listResources(query) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listResources")
      return listIntegrationResources(pluginId, query)
    },
    async checkAccountHealth(accountId) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.checkAccountHealth")
      return checkIntegrationAccountHealth(pluginId, accountId)
    },
    async createSubscription(
      input: IntegrationSubscriptionInput
    ): Promise<IntegrationSubscription> {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.createSubscription")
      const definition = getRegisteredIntegration(pluginId, input.integrationId)?.definition
      if (!definition) throw new Error(`Integration "${input.integrationId}" is not registered`)
      if (
        input.inboxProjectionId &&
        !definition.inboxProjections?.some(
          (projection) => projection.id === input.inboxProjectionId
        )
      ) {
        throw new Error(`Inbox projection "${input.inboxProjectionId}" is not declared`)
      }
      return createIntegrationSubscription(pluginId, input)
    },
    async removeSubscription(subscriptionId) {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.removeSubscription")
      const { deleteIntegrationSubscription } = await import("@/lib/integrations/ingress-client")
      await deleteIntegrationSubscription(pluginId, subscriptionId)
    },
    async publishEvent(event: IntegrationEventEnvelope) {
      requirePermission(hasPermission, "integrations:events", "ctx.integrations.publishEvent")
      const result = await publishIntegrationEvent(pluginId, event)
      return { inserted: result.inserted }
    },
    async executeAction(input): Promise<IntegrationActionJob> {
      requirePermission(hasPermission, "integrations:execute", "ctx.integrations.executeAction")
      return executeIntegrationAction(pluginId, input)
    },
    async getActionJob(jobId) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.getActionJob")
      const job = await getIntegrationActionJob(jobId)
      return job?.pluginId === pluginId ? job : undefined
    },
    async cancelAction(jobId) {
      requirePermission(hasPermission, "integrations:execute", "ctx.integrations.cancelAction")
      const job = await getIntegrationActionJob(jobId)
      if (!job || job.pluginId !== pluginId) {
        throw new Error(`Integration action job "${jobId}" was not found`)
      }
      return cancelIntegrationActionJob(jobId)
    },
    async authenticatedRequest<T>(accountId: string, input: string, init?: IntegrationRequestInit) {
      requirePermission(
        hasPermission,
        "integrations:execute",
        "ctx.integrations.authenticatedRequest"
      )
      const account = await getIntegrationAccount(pluginId, accountId)
      if (!account) throw new Error(`Integration account "${accountId}" was not found`)
      return authenticatedIntegrationRequest<T>(pluginId, accountId, input, init)
    },
    async getIngressPublicUrl(subscriptionId) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.getIngressPublicUrl")
      const subscription = (await listIntegrationSubscriptions(pluginId)).find(
        (candidate) => candidate.id === subscriptionId
      )
      if (!subscription) return undefined
      const endpoint = await getIntegrationIngressEndpoint(pluginId, subscription.accountId)
      if (!endpoint) return undefined
      const { getIntegrationIngressPublicUrl } = await import("@/lib/integrations/ingress-client")
      return getIntegrationIngressPublicUrl(endpoint.routeId)
    },
    async listIngressDeadletters(accountId) {
      requirePermission(
        hasPermission,
        "integrations:read",
        "ctx.integrations.listIngressDeadletters"
      )
      const { listIntegrationIngressDeadletters } =
        await import("@/lib/integrations/ingress-client")
      return listIntegrationIngressDeadletters(pluginId, accountId)
    },
    async getIngressDeadletter(accountId, routeId, deliveryId) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.getIngressDeadletter")
      const { getIntegrationIngressDeadletter } = await import("@/lib/integrations/ingress-client")
      return getIntegrationIngressDeadletter(pluginId, accountId, routeId, deliveryId)
    },
    async requeueIngressDeadletter(accountId, routeId, deliveryId) {
      requirePermission(
        hasPermission,
        "integrations:manage",
        "ctx.integrations.requeueIngressDeadletter"
      )
      const { requeueIntegrationIngressDeadletter } =
        await import("@/lib/integrations/ingress-client")
      return requeueIntegrationIngressDeadletter(pluginId, accountId, routeId, deliveryId)
    },
    async migrateLegacy(plan) {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.migrateLegacy")
      return migrateLegacyIntegration(pluginId, plan)
    },
    async rollbackMigration(migrationId) {
      requirePermission(hasPermission, "integrations:manage", "ctx.integrations.rollbackMigration")
      await rollbackIntegrationMigration(pluginId, migrationId)
    },
  }
}
