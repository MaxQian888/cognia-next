/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  activateConnectorConversation,
  closeConnectorConversation,
  getConnectorConversationState,
  touchConnectorConversation,
} from "./connector-conversation-state"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"

const TARGET: ConversationDeliveryTarget = {
  address: {
    conversationKey: "lark:lk-1:oc-1:omt-1",
    platform: "lark",
    adapterId: "lk-1",
    scopeKind: "thread",
    containerId: "oc-1",
    topicId: "omt-1",
  },
  conversationRef: {
    platform: "lark",
    adapterId: "lk-1",
    channelId: "oc-1",
    threadTs: "omt-1",
    threadRootMessageId: "om-1",
  },
  sourceMessageId: "om-1",
  refreshedAt: 1_000,
}

describe("connector conversation state", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists activation, refreshes the latest target, and closes explicitly", async () => {
    await activateConnectorConversation(TARGET, {
      activatedBy: "ou-1",
      expiresAt: 86_401_000,
      now: 1_000,
    })

    expect(await getConnectorConversationState(TARGET.address.conversationKey)).toEqual(
      expect.objectContaining({
        conversationKey: TARGET.address.conversationKey,
        adapterId: "lk-1",
        activationStatus: "active",
        activatedBy: "ou-1",
        expiresAt: 86_401_000,
        deliveryTarget: TARGET,
      })
    )

    const refreshed: ConversationDeliveryTarget = {
      ...TARGET,
      sourceMessageId: "om-2",
      refreshedAt: 2_000,
      conversationRef: { ...TARGET.conversationRef, threadRootMessageId: "om-2" },
    }
    await touchConnectorConversation(TARGET.address.conversationKey, {
      deliveryTarget: refreshed,
      expiresAt: 86_402_000,
      now: 2_000,
    })
    expect(
      (await getConnectorConversationState(TARGET.address.conversationKey))?.deliveryTarget
    ).toEqual(refreshed)

    await closeConnectorConversation(TARGET.address.conversationKey, { now: 3_000 })
    const closed = await getConnectorConversationState(TARGET.address.conversationKey)
    expect(closed).toEqual(expect.objectContaining({ activationStatus: "inactive" }))
    expect(closed?.expiresAt).toBeUndefined()
  })
})
