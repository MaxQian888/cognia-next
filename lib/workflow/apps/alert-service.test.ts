jest.mock("@/lib/notifications/runtime", () => ({ notify: jest.fn() }))
jest.mock("@/lib/webhooks/egress-registry", () => ({ publishOutboundEvent: jest.fn() }))

import { notify } from "@/lib/notifications/runtime"
import { publishOutboundEvent } from "@/lib/webhooks/egress-registry"
import type { WorkflowApp, WorkflowAppRelease } from "@/types/workflow/app"
import { emitWorkflowAppQuotaAlert } from "./alert-service"
import { WorkflowAppQuotaError } from "./quota-service"

const app = {
  id: "app_1",
  accountId: "account_1",
  workflowId: "workflow_1",
  kind: "workflow",
  slug: "release-review",
} as WorkflowApp

const release = {
  id: "release_2",
  appId: "app_1",
  workflowId: "workflow_1",
} as WorkflowAppRelease

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(notify).mockResolvedValue("notification_1")
  jest.mocked(publishOutboundEvent).mockResolvedValue([])
})

it("fans budget exhaustion out to durable notifications and signed webhooks", async () => {
  const result = await emitWorkflowAppQuotaAlert({
    app,
    release,
    error: new WorkflowAppQuotaError("token_budget_exhausted", "spent", 60),
    now: 172_800_000,
  })

  expect(result).toEqual({
    emitted: true,
    notificationDelivered: true,
    webhookDelivered: true,
  })
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "workflow",
      level: "critical",
      channels: ["center", "toast", "push"],
      dedupeKey: "workflow-app-budget:app_1:token_budget_exhausted:2",
      meta: expect.objectContaining({ appId: "app_1", appReleaseId: "release_2" }),
    })
  )
  expect(publishOutboundEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: "workflow.app.budget_exhausted",
      source: "workflow-app",
      payload: expect.objectContaining({ quotaCode: "token_budget_exhausted" }),
    })
  )
})

it("does not alert on transient rate or concurrency pressure", async () => {
  const result = await emitWorkflowAppQuotaAlert({
    app,
    release,
    error: new WorkflowAppQuotaError("concurrency_exhausted", "busy", 1),
  })

  expect(result.emitted).toBe(false)
  expect(notify).not.toHaveBeenCalled()
  expect(publishOutboundEvent).not.toHaveBeenCalled()
})

it("isolates notification and webhook delivery failures", async () => {
  jest.mocked(notify).mockRejectedValueOnce(new Error("notification offline"))
  jest.mocked(publishOutboundEvent).mockRejectedValueOnce(new Error("webhook offline"))

  await expect(
    emitWorkflowAppQuotaAlert({
      app,
      release,
      error: new WorkflowAppQuotaError("cost_budget_exhausted", "spent"),
    })
  ).resolves.toEqual({
    emitted: true,
    notificationDelivered: false,
    webhookDelivered: false,
  })
})
