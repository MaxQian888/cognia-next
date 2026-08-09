import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import {
  appendIntegrationAudit,
  listIntegrationAccounts,
  updateIntegrationAccount,
} from "@/lib/db/integrations"
import { authenticatedGithubAppRequest } from "./github-auth"

interface GithubHookDelivery {
  id: number
  guid?: string
  status_code?: number
  delivered_at?: string
}

interface AppResponse<T> {
  status: number
  headers: Record<string, string>
  data: T
}

export interface GithubDeliveryRecoveryDependencies {
  listAccounts(pluginId: string): Promise<IntegrationAccount[]>
  request<T>(sessionId: string, path: string, init?: { method?: string }): Promise<AppResponse<T>>
  updateAccount(
    pluginId: string,
    accountId: string,
    patch: Parameters<typeof updateIntegrationAccount>[2]
  ): Promise<unknown>
  appendAudit(input: Parameters<typeof appendIntegrationAudit>[0]): Promise<unknown>
  now(): number
}

function dependencies(): GithubDeliveryRecoveryDependencies {
  return {
    listAccounts: listIntegrationAccounts,
    request: authenticatedGithubAppRequest,
    updateAccount: updateIntegrationAccount,
    appendAudit: appendIntegrationAudit,
    now: Date.now,
  }
}

function numberHeader(headers: Record<string, string>, name: string): number | undefined {
  const value = Number(headers[name])
  return Number.isFinite(value) ? value : undefined
}

function recoverable(delivery: GithubHookDelivery): boolean {
  const status = delivery.status_code ?? 0
  return status === 0 || status === 429 || status >= 500
}

function afterCheckpoint(deliveryId: number, checkpoint?: string): boolean {
  if (!checkpoint) return true
  try {
    return BigInt(deliveryId) > BigInt(checkpoint)
  } catch {
    return true
  }
}

export async function reconcileGithubAppDeliveries(
  provided?: GithubDeliveryRecoveryDependencies
): Promise<void> {
  const deps = provided ?? dependencies()
  const accounts = (await deps.listAccounts("github-delivery")).filter(
    (account) => account.integrationId === "github" && account.enabled
  )
  await Promise.all(
    accounts.map(async (account) => {
      const checkedAt = new Date(deps.now()).toISOString()
      if (account.providerId !== "github-app") {
        await deps.updateAccount(account.pluginId, account.id, {
          status: {
            ...(account.status ?? { health: account.health, checkedAt }),
            code: "remote_reconciliation_unavailable",
            message:
              "GitHub App delivery reconciliation is unavailable for personal access token accounts; local dead-letter recovery remains available.",
            checkedAt,
            lastSyncAt: checkedAt,
          },
        })
        return
      }

      const checkpoint = account.status?.deliveryRecovery?.lastDeliveryId
      const pending = new Set(account.status?.deliveryRecovery?.pendingRedeliveryIds ?? [])
      const attempted = new Set<string>()
      const retryIds = [...pending]
      const responseHeaders: Record<string, string> = {}
      let newest: GithubHookDelivery | undefined
      let page = 1
      let reachedCheckpoint = false
      const unseen: GithubHookDelivery[] = []

      while (page <= 100 && !reachedCheckpoint) {
        const response = await deps.request<GithubHookDelivery[]>(
          account.authSessionId,
          `/app/hook/deliveries?per_page=100&page=${page}`
        )
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `GitHub App delivery reconciliation failed with status ${response.status}`
          )
        }
        Object.assign(responseHeaders, response.headers)
        if (!Array.isArray(response.data)) {
          throw new Error("GitHub App delivery reconciliation returned an invalid response")
        }
        newest ??= response.data[0]
        for (const delivery of response.data) {
          if (!afterCheckpoint(delivery.id, checkpoint)) {
            reachedCheckpoint = true
            break
          }
          unseen.push(delivery)
        }
        if (response.data.length < 100) break
        page += 1
      }

      const candidates: GithubHookDelivery[] = [
        ...retryIds.map((id): GithubHookDelivery => ({ id: Number(id) })),
        ...unseen.filter(recoverable),
      ]
      for (const delivery of candidates) {
        const deliveryId = String(delivery.id)
        if (attempted.has(deliveryId)) continue
        attempted.add(deliveryId)
        const redelivery = await deps.request(
          account.authSessionId,
          `/app/hook/deliveries/${delivery.id}/attempts`,
          { method: "POST" }
        )
        const succeeded = redelivery.status >= 200 && redelivery.status < 300
        if (succeeded) pending.delete(deliveryId)
        else pending.add(deliveryId)
        await deps.appendAudit({
          pluginId: account.pluginId,
          integrationId: account.integrationId,
          accountId: account.id,
          kind: "github.delivery.redelivery",
          outcome: succeeded ? "succeeded" : "failed",
          detail: {
            deliveryId: String(delivery.id),
            deliveryGuid: delivery.guid,
            status: delivery.status_code,
            requestId: redelivery.headers["x-github-request-id"],
          },
        })
      }
      const reset = numberHeader(responseHeaders, "x-ratelimit-reset")
      await deps.updateAccount(account.pluginId, account.id, {
        status: {
          ...(account.status ?? { health: account.health, checkedAt }),
          code: undefined,
          message: undefined,
          checkedAt,
          lastSyncAt: checkedAt,
          rateLimit: {
            remaining: numberHeader(responseHeaders, "x-ratelimit-remaining"),
            resetAt: reset === undefined ? undefined : new Date(reset * 1000).toISOString(),
          },
          deliveryRecovery: {
            lastCheckedAt: checkedAt,
            lastDeliveryId: newest ? String(newest.id) : checkpoint,
            pendingRedeliveryIds: [...pending],
          },
        },
      })
    })
  )
}
