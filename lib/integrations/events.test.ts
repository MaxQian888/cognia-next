/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount, createIntegrationSubscription } from "@/lib/db/integrations"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { publishIntegrationEvent } from "./events"

const findMatchingWorkflows = jest.fn()
const dispatchTrigger = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflows(...args),
}))
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTrigger(...args),
}))

describe("Integration event publication", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    findMatchingWorkflows.mockReset()
    dispatchTrigger.mockReset()
    findMatchingWorkflows.mockReturnValue([{ workflowId: "wf-1", nodeId: "trigger-1", params: {} }])
    dispatchTrigger.mockResolvedValue(undefined)
  })

  async function setup() {
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [
            {
              id: "issue.updated",
              label: "Issue updated",
              resourceKinds: ["issue"],
            },
          ],
          actions: [],
          inboxProjections: [
            {
              id: "issue-thread",
              label: "Issue thread",
              eventTypes: ["issue.updated"],
              threadKeyPointer: "/issue/id",
              titlePointer: "/issue/title",
              bodyPointer: "/comment/body",
              urlPointer: "/issue/url",
            },
          ],
        },
      ],
      handlers: {},
    })
    const account = await createIntegrationAccount("example-delivery", {
      integrationId: "example",
      providerId: "example-oauth",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "Example",
    })
    const subscription = await createIntegrationSubscription("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      resourceKind: "issue",
      resourceId: "EX-1",
      eventTypes: ["issue.updated"],
      inboxProjectionId: "issue-thread",
    })
    return { account, subscription }
  }

  it("fans a normalized event to Workflow and a host-owned Inbox thread once", async () => {
    const { account, subscription } = await setup()
    const event = {
      schemaVersion: 1 as const,
      id: "event-1",
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      deliveryId: "delivery-1",
      eventType: "issue.updated",
      resource: { kind: "issue", id: "EX-1" },
      occurredAt: "2026-07-28T00:00:00.000Z",
      receivedAt: "2026-07-28T00:00:01.000Z",
      payload: {
        issue: { id: "EX-1", title: "Fix the integration", url: "https://example.test/EX-1" },
        comment: { body: "Ready for review" },
      },
    }

    await expect(publishIntegrationEvent("example-delivery", event)).resolves.toEqual({
      inserted: true,
      // No Bot is installed in this fixture. Zero is the honest count, not a
      // sign the Bot plane was skipped.
      botDeliveries: 0,
      workflowDispatches: 1,
      inboxProjections: 1,
    })
    await expect(publishIntegrationEvent("example-delivery", event)).resolves.toEqual({
      inserted: false,
      workflowDispatches: 0,
      inboxProjections: 0,
      botDeliveries: 0,
    })

    expect(findMatchingWorkflows).toHaveBeenCalledWith("trigger.integration.event", {
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      eventType: "issue.updated",
      resourceKind: "issue",
      resourceId: "EX-1",
    })
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        triggerId: "trigger-1",
        kind: "trigger.integration.event",
        payload: expect.objectContaining({ subscriptionId: subscription.id }),
      })
    )

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      title: "Fix the integration",
      integrationBinding: {
        pluginId: "example-delivery",
        integrationId: "example",
        accountId: account.id,
        projectionId: "issue-thread",
        threadKey: "EX-1",
      },
    })
    const messages = await getDb().messages.where("sessionId").equals(sessions[0].id).toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Ready for review\n\nhttps://example.test/EX-1" },
    ])
  })

  it("dispatches each Workflow trigger once when multiple subscriptions match", async () => {
    const { account, subscription } = await setup()
    const second = await createIntegrationSubscription("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      resourceKind: "issue",
      resourceId: "EX-1",
      eventTypes: ["issue.updated"],
      inboxProjectionId: "issue-thread",
    })

    await publishIntegrationEvent("example-delivery", {
      schemaVersion: 1,
      id: "event-many-subscriptions",
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      deliveryId: "delivery-many-subscriptions",
      eventType: "issue.updated",
      resource: { kind: "issue", id: "EX-1" },
      occurredAt: "2026-07-28T00:00:00.000Z",
      receivedAt: "2026-07-28T00:00:01.000Z",
      payload: {
        issue: { id: "EX-1", title: "Fix duplicate dispatches" },
        comment: { body: null },
      },
    })

    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    const subscriptionIds = [subscription.id, second.id].sort()
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          subscriptionId: subscriptionIds[0],
          subscriptionIds,
        }),
      })
    )
    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual([{ type: "text", text: "Fix duplicate dispatches" }])
  })
})
