import { getIntegrationAccount, updateIntegrationAccount } from "@/lib/db/integrations"
import type {
  IntegrationAccountStatus,
  IntegrationProviderContext,
  IntegrationResourcePage,
  IntegrationResourceQuery,
} from "@/types/plugin/plugin-integration"
import { authenticatedIntegrationRequest } from "./action-runner"
import {
  getIntegrationAccountStatusProvider,
  getIntegrationResourceProvider,
  getRegisteredIntegration,
} from "./registry"

function providerContext(
  pluginId: string,
  integrationId: string,
  accountId: string
): IntegrationProviderContext {
  return {
    pluginId,
    integrationId,
    accountId,
    authenticatedRequest: (input, init) =>
      authenticatedIntegrationRequest(pluginId, accountId, input, init),
  }
}

async function requireAccount(pluginId: string, accountId: string) {
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account) throw new Error(`Integration account "${accountId}" was not found`)
  return account
}

export async function listIntegrationResources(
  pluginId: string,
  query: IntegrationResourceQuery
): Promise<IntegrationResourcePage> {
  const account = await requireAccount(pluginId, query.accountId)
  const registered = getRegisteredIntegration(pluginId, account.integrationId)
  const provider = getIntegrationResourceProvider(pluginId, account.integrationId)
  if (!registered?.definition.resourceProvider || !provider) {
    throw new Error(`Integration "${account.integrationId}" does not provide resource discovery`)
  }
  if (!registered.definition.resourceProvider.kinds.includes(query.kind)) {
    throw new Error(`Integration resource kind "${query.kind}" is not discoverable`)
  }
  const page = await provider(
    { ...query, limit: Math.min(Math.max(query.limit ?? 50, 1), 100) },
    providerContext(pluginId, account.integrationId, account.id)
  )
  if (page.items.some((item) => item.kind !== query.kind)) {
    throw new Error("Integration resource provider returned an unexpected resource kind")
  }
  return page
}

export async function checkIntegrationAccountHealth(
  pluginId: string,
  accountId: string
): Promise<IntegrationAccountStatus> {
  const account = await requireAccount(pluginId, accountId)
  const provider = getIntegrationAccountStatusProvider(pluginId, account.integrationId)
  if (!provider) {
    throw new Error(`Integration "${account.integrationId}" does not provide health checks`)
  }
  const status = await provider(providerContext(pluginId, account.integrationId, account.id))
  const normalized = {
    ...status,
    requiredPermissions: status.requiredPermissions
      ? [...new Set(status.requiredPermissions)].sort()
      : undefined,
    grantedPermissions: status.grantedPermissions
      ? [...new Set(status.grantedPermissions)].sort()
      : undefined,
  }
  await updateIntegrationAccount(pluginId, account.id, {
    health: normalized.health,
    status: normalized,
  })
  return normalized
}
