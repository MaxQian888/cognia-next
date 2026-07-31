import { createDiagnostic } from "@cognia/diagnostics"
import { detectPlatform } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { removeIntegrationAccount, removeIntegrationSubscription } from "@/lib/db/integrations"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { removeSession } from "@/lib/plugin/auth/auth-provider-registry"
import { publishIntegrationEvent } from "./events"
import { getIntegrationEventNormalizer, getRegisteredIntegration } from "./registry"
import type {
  IntegrationIngressVerification,
  IntegrationVerifiedDelivery,
} from "@/types/plugin/plugin-integration"

interface IngressRouteInput {
  routeId: string
  pluginId: string
  integrationId: string
  accountId: string
  subscriptionId?: string
  path: string
  verification: IntegrationIngressVerification & { secretHandle: string }
  deliveryIdHeader?: string
  eventTypeHeader?: string
  enabled: boolean
}

type IngressDeliveryStage = "route" | "normalize" | "publish" | "acknowledge"

function reportIngressFailure(
  delivery: Pick<IntegrationVerifiedDelivery, "routeId" | "deliveryId">,
  stage: IngressDeliveryStage,
  error: unknown
): void {
  dispatchDiagnostic(
    createDiagnostic("serverError", {
      source: "connector",
      message: error instanceof Error ? error.message : String(error),
      meta: {
        extra: {
          stage,
          routeId: delivery.routeId,
          deliveryId: delivery.deliveryId,
        },
      },
    }),
    { kind: "background" }
  )
}

function supportsIntegrationExecution(): boolean {
  const platform = detectPlatform()
  return platform === "tauri" || platform === "headless"
}

/** Resolve the local/tunnel URL for a registered Integration ingress route. */
export async function getIntegrationIngressPublicUrl(routeId: string): Promise<string | undefined> {
  if (!supportsIntegrationExecution()) return undefined
  return transport
    .call<string | null>("integration_ingress_get_url", { routeId })
    .then((value) => value ?? undefined)
}

export async function syncIntegrationIngressRoutes(): Promise<number> {
  if (!supportsIntegrationExecution()) return 0
  const db = getDb()
  const subscriptions = await db.integrationSubscriptions.toArray()
  const accounts = await db.integrationAccounts.toArray()
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  let registered = 0
  for (const subscription of subscriptions) {
    const account = accountById.get(subscription.accountId)
    const routeId = subscription.ingressRouteId
    const secretHandle = subscription.ingressSecretHandle
    if (!account || !routeId || !secretHandle) continue
    const integration = getRegisteredIntegration(subscription.pluginId, subscription.integrationId)
    const ingress = integration?.definition.ingress
    if (!ingress) continue
    const input: IngressRouteInput = {
      routeId,
      pluginId: subscription.pluginId,
      integrationId: subscription.integrationId,
      accountId: subscription.accountId,
      subscriptionId: subscription.id,
      path: routeId,
      verification: { ...ingress.verification, secretHandle },
      deliveryIdHeader: ingress.deliveryIdHeader,
      eventTypeHeader: ingress.eventTypeHeader,
      enabled: subscription.enabled && account.enabled,
    }
    await transport.call("integration_ingress_register", { input })
    registered += 1
  }
  return registered
}

export async function drainIntegrationIngress(): Promise<number> {
  if (!supportsIntegrationExecution()) return 0
  const deliveries = await transport.call<IntegrationVerifiedDelivery[]>(
    "integration_ingress_poll",
    {
      limit: 100,
    }
  )
  const subscriptions = await getDb().integrationSubscriptions.toArray()
  const byRoute = new Map(
    subscriptions
      .filter((subscription) => subscription.ingressRouteId)
      .map((subscription) => [subscription.ingressRouteId!, subscription])
  )
  let acknowledged = 0
  for (const delivery of deliveries) {
    const subscription = byRoute.get(delivery.routeId)
    let stage: IngressDeliveryStage = "route"
    try {
      if (!subscription) throw new Error(`Integration ingress route "${delivery.routeId}" is stale`)
      const normalizer = getIntegrationEventNormalizer(
        subscription.pluginId,
        subscription.integrationId
      )
      if (!normalizer) throw new Error("Integration ingress normalizer is unavailable")
      stage = "normalize"
      const normalized = await normalizer(delivery, {
        pluginId: subscription.pluginId,
        integrationId: subscription.integrationId,
        accountId: subscription.accountId,
        subscriptionId: subscription.id,
      })
      stage = "publish"
      for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
        await publishIntegrationEvent(subscription.pluginId, event)
      }
      stage = "acknowledge"
      await transport.call("integration_ingress_ack", {
        routeId: delivery.routeId,
        deliveryId: delivery.deliveryId,
      })
      acknowledged += 1
    } catch (error) {
      reportIngressFailure(delivery, stage, error)
      await transport.call("integration_ingress_nack", {
        routeId: delivery.routeId,
        deliveryId: delivery.deliveryId,
      })
    }
  }
  return acknowledged
}

export async function installIntegrationIngressRuntime(): Promise<() => void> {
  if (!supportsIntegrationExecution()) return () => undefined
  await syncIntegrationIngressRoutes()
  await drainIntegrationIngress()
  return transport.subscribe("integration:delivery-available", () => {
    void drainIntegrationIngress().catch((error) =>
      reportIngressFailure(
        {
          routeId: "runtime",
          deliveryId: "subscription",
        },
        "route",
        error
      )
    )
  })
}

export async function deleteIntegrationSubscription(
  pluginId: string,
  subscriptionId: string
): Promise<void> {
  const subscription = await getDb().integrationSubscriptions.get(subscriptionId)
  if (!subscription || subscription.pluginId !== pluginId) return
  if (subscription.ingressRouteId && supportsIntegrationExecution()) {
    await transport.call("integration_ingress_unregister", {
      routeId: subscription.ingressRouteId,
    })
  }
  if (subscription.ingressSecretHandle) {
    await createKeyringStore("integration-ingress").delete(subscription.ingressSecretHandle)
  }
  await removeIntegrationSubscription(pluginId, subscriptionId)
}

export async function deleteIntegrationAccount(pluginId: string, accountId: string): Promise<void> {
  const account = await getDb().integrationAccounts.get(accountId)
  if (!account || account.pluginId !== pluginId) return
  const subscriptions = await getDb()
    .integrationSubscriptions.where("accountId")
    .equals(accountId)
    .toArray()
  for (const subscription of subscriptions) {
    if (subscription.pluginId === pluginId) {
      await deleteIntegrationSubscription(pluginId, subscription.id)
    }
  }
  await removeIntegrationAccount(pluginId, accountId)
  const sharedCredential = await getDb()
    .integrationAccounts.filter(
      (candidate) =>
        candidate.providerId === account.providerId &&
        candidate.authSessionId === account.authSessionId
    )
    .first()
  if (!sharedCredential) {
    await removeSession(account.providerId, account.authSessionId)
  }
}
