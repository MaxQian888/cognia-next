import type {
  IntegrationAccount,
  IntegrationAccountRef,
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
  integrationApiBaseUrl,
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

import { resolveBotIntegrationBinding } from "./bot-integration-binding"

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
    async listSubscriptions(accountId?: IntegrationAccountRef): Promise<IntegrationSubscription[]> {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listSubscriptions")
      if (accountId && typeof accountId !== "string") {
        const binding = await resolveBotIntegrationBinding(pluginId, accountId)
        const subscriptions = await listIntegrationSubscriptions(
          binding.account.pluginId,
          binding.account.id
        )
        // A repository-scoped installation sees only its repository's
        // subscriptions; other bindings are scoped by the bound account itself.
        return binding.repository
          ? subscriptions.filter(
              (subscription) =>
                subscription.resourceKind === "repository" &&
                subscription.resourceId?.toLowerCase() === binding.repository
            )
          : subscriptions
      }
      return listIntegrationSubscriptions(pluginId, accountId)
    },
    async listResources(query) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.listResources")
      if (typeof query.accountId !== "string") {
        const binding = await resolveBotIntegrationBinding(pluginId, query.accountId)
        if (binding.repository && query.kind !== "repository")
          throw new Error("Bot binding only permits scoped repository discovery")
        const page = await listIntegrationResources(binding.account.pluginId, {
          ...query,
          accountId: binding.account.id,
        })
        return binding.repository
          ? {
              ...page,
              items: page.items.filter((item) => item.id.toLowerCase() === binding.repository),
            }
          : page
      }
      return listIntegrationResources(pluginId, { ...query, accountId: query.accountId })
    },
    async checkAccountHealth(accountId) {
      requirePermission(hasPermission, "integrations:read", "ctx.integrations.checkAccountHealth")
      if (typeof accountId !== "string") {
        const binding = await resolveBotIntegrationBinding(pluginId, accountId)
        return checkIntegrationAccountHealth(binding.account.pluginId, binding.account.id)
      }
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
      if (job?.pluginId === pluginId) return job
      if (job?.botBinding?.pluginId === pluginId) return job
      return undefined
    },
    async cancelAction(jobId) {
      requirePermission(hasPermission, "integrations:execute", "ctx.integrations.cancelAction")
      const job = await getIntegrationActionJob(jobId)
      if (job?.botBinding?.pluginId === pluginId) {
        const binding = await resolveBotIntegrationBinding(pluginId, job.botBinding)
        if (binding.account.id === job.accountId) return cancelIntegrationActionJob(jobId)
      }
      if (!job || job.pluginId !== pluginId) {
        throw new Error(`Integration action job "${jobId}" was not found`)
      }
      return cancelIntegrationActionJob(jobId)
    },
    async authenticatedRequest<T>(
      accountId: IntegrationAccountRef,
      input: string,
      init?: IntegrationRequestInit
    ) {
      requirePermission(
        hasPermission,
        "integrations:execute",
        "ctx.integrations.authenticatedRequest"
      )
      if (typeof accountId !== "string") {
        const binding = await resolveBotIntegrationBinding(pluginId, accountId)
        if ((init?.method ?? "GET").toUpperCase() !== "GET" || init?.body !== undefined) {
          throw new Error(
            "Bot binding authenticated requests are read-only; use executeAction for writes"
          )
        }
        // Raw authenticated requests stay repository-scoped: integrations
        // without a repository boundary expose the structured action broker
        // (`executeAction`) instead of arbitrary HTTP.
        if (!binding.repository) {
          throw new Error("Bot binding requests require a repository-scoped installation")
        }
        const url = new URL(input)
        const base = new URL(
          (await integrationApiBaseUrl(binding.account)) ?? "https://api.github.com"
        )
        const prefix = `${base.pathname.replace(/\/$/, "")}/repos/${binding.repository}`
        const ownIdentity =
          binding.account.pluginId === "github-delivery" &&
          url.pathname === `${base.pathname.replace(/\/$/, "")}/user` &&
          !url.search &&
          !url.hash
        if (
          url.origin !== base.origin ||
          url.username ||
          url.password ||
          !(
            ownIdentity ||
            url.pathname.toLowerCase() === prefix ||
            url.pathname.toLowerCase().startsWith(`${prefix}/`)
          ) ||
          /%2f|%5c|%2e|\\/i.test(url.pathname)
        ) {
          throw new Error("Bot binding request is outside its repository scope")
        }
        const response = await authenticatedIntegrationRequest<T>(
          binding.account.pluginId,
          binding.account.id,
          input,
          init
        )
        if (!ownIdentity) return response
        const identity = response.data as { login?: unknown; id?: unknown } | null
        return {
          ...response,
          data: {
            ...(typeof identity?.login === "string" ? { login: identity.login } : {}),
            ...(typeof identity?.id === "number" ? { id: identity.id } : {}),
          } as T,
        }
      }
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
