import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { updateIntegrationAccount } from "@/lib/db/integrations"
import { authenticatedGithubAppRequest } from "./github-auth"
import { syncIntegrationIngressRoutes } from "./ingress-client"

export interface GithubWebhookDependencies {
  request<T>(
    sessionId: string,
    path: string,
    init?: { method?: string; body?: Record<string, unknown> }
  ): Promise<{ status: number; headers: Record<string, string>; data: T }>
  saveSecret(handle: string, secret: string): Promise<void>
  deleteSecret(handle: string): Promise<void>
  updateAccount: typeof updateIntegrationAccount
  syncIngress(): Promise<number>
  createHandle(): string
  now(): number
}

function dependencies(): GithubWebhookDependencies {
  const store = createKeyringStore("integration-ingress")
  return {
    request: authenticatedGithubAppRequest,
    saveSecret: (handle, secret) => store.save(handle, secret),
    deleteSecret: (handle) => store.delete(handle),
    updateAccount: updateIntegrationAccount,
    syncIngress: syncIntegrationIngressRoutes,
    createHandle: crypto.randomUUID,
    now: Date.now,
  }
}

export async function rotateGithubWebhookSecret(
  account: IntegrationAccount,
  webhookUrl: string,
  newSecret: string,
  provided?: GithubWebhookDependencies
): Promise<void> {
  if (
    account.pluginId !== "github-delivery" ||
    account.integrationId !== "github" ||
    account.providerId !== "github-app"
  ) {
    throw new Error("Remote webhook management requires a GitHub App account")
  }
  if (!account.dedicatedAppConfirmed) {
    throw new Error("Remote webhook management requires dedicated App confirmation")
  }
  if (!account.ingressEndpoint) throw new Error("GitHub webhook ingress endpoint is unavailable")
  const deps = provided ?? dependencies()
  const newHandle = deps.createHandle()
  await deps.saveSecret(newHandle, newSecret)
  try {
    const response = await deps.request(account.authSessionId, "/app/hook/config", {
      method: "PATCH",
      body: {
        url: webhookUrl,
        content_type: "json",
        insecure_ssl: "0",
        secret: newSecret,
      },
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub webhook update failed with status ${response.status}`)
    }
    const previousHandle = account.ingressEndpoint.secretHandle
    await deps.updateAccount(account.pluginId, account.id, {
      ingressEndpoint: {
        ...account.ingressEndpoint,
        secretHandle: newHandle,
        updatedAt: new Date(deps.now()).toISOString(),
      },
      status: {
        ...(account.status ?? {
          health: account.health,
          checkedAt: new Date(deps.now()).toISOString(),
        }),
        code: "webhook_verified",
        message: undefined,
        checkedAt: new Date(deps.now()).toISOString(),
      },
    })
    await deps.syncIngress()
    await deps.deleteSecret(previousHandle)
  } catch (error) {
    await deps.deleteSecret(newHandle)
    throw error
  }
}
