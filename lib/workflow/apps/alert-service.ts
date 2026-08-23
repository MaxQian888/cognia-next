import { notify } from "@/lib/notifications/runtime"
import { publishOutboundEvent } from "@/lib/webhooks/egress-registry"
import type { WorkflowApp, WorkflowAppRelease } from "@/types/workflow/app"
import type { WorkflowAppQuotaError } from "./quota-service"

const BUDGET_ERROR_CODES = new Set<WorkflowAppQuotaError["code"]>([
  "token_budget_exhausted",
  "cost_budget_exhausted",
  "cost_budget_unknown",
])

export interface WorkflowAppAlertDelivery {
  emitted: boolean
  notificationDelivered: boolean
  webhookDelivered: boolean
}

/**
 * Fan a deployment-budget rejection into the existing durable Notification
 * Center/mobile-push pipeline and signed Standard Webhooks egress registry.
 * Delivery failures are isolated so the original quota error remains the API
 * authority and can never be replaced by an alert transport failure.
 */
export async function emitWorkflowAppQuotaAlert(input: {
  app: WorkflowApp
  release: WorkflowAppRelease
  error: WorkflowAppQuotaError
  now?: number
}): Promise<WorkflowAppAlertDelivery> {
  if (!BUDGET_ERROR_CODES.has(input.error.code)) {
    return { emitted: false, notificationDelivered: false, webhookDelivered: false }
  }

  const now = input.now ?? Date.now()
  const day = Math.floor(now / 86_400_000)
  const metadata = {
    appId: input.app.id,
    appSlug: input.app.slug,
    appReleaseId: input.release.id,
    workflowId: input.release.workflowId,
    quotaCode: input.error.code,
    retryAfterSeconds: input.error.retryAfterSeconds,
  }
  const [notification, webhook] = await Promise.allSettled([
    notify({
      source: "workflow",
      level: "critical",
      title: `Workflow app budget exhausted: ${input.app.slug}`,
      body: "New requests are blocked while in-flight runs continue. Review the deployment budget before resuming traffic.",
      channels: ["center", "toast", "push"],
      dedupeKey: `workflow-app-budget:${input.app.id}:${input.error.code}:${day}`,
      groupKey: `workflow-app:${input.app.id}`,
      sourceRef: { kind: "workflow-app", id: input.app.id },
      directed: true,
      meta: metadata,
    }),
    publishOutboundEvent({
      id: crypto.randomUUID(),
      eventType: "workflow.app.budget_exhausted",
      source: "workflow-app",
      payload: metadata,
      occurredAt: new Date(now).toISOString(),
    }),
  ])

  return {
    emitted: true,
    notificationDelivered: notification.status === "fulfilled",
    webhookDelivered: webhook.status === "fulfilled",
  }
}
