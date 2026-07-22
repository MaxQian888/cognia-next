/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { recoverActiveConversationHistory } from "./history-recovery"

jest.mock("./runtime", () => ({
  findSessionByConversationKey: jest.fn(async () => undefined),
  insertInboundMessage: jest.fn(async () => undefined),
}))

const TARGET = {
  address: {
    conversationKey: "lark:lk-1:oc-1:omt-1",
    platform: "lark" as const,
    adapterId: "lk-1",
    scopeKind: "thread" as const,
    containerId: "oc-1",
    topicId: "omt-1",
  },
  conversationRef: { platform: "lark" as const, adapterId: "lk-1", channelId: "oc-1" },
  refreshedAt: 1,
}

function event(
  messageId: string,
  timestamp: number,
  conversationKey = TARGET.address.conversationKey
) {
  return {
    platform: "lark",
    adapterId: "lk-1",
    selfId: "bot",
    messageId,
    conversationRef: TARGET.conversationRef,
    conversationKey,
    conversationAddress: { ...TARGET.address, conversationKey },
    sender: { id: "u-1", platform: "lark", adapterId: "lk-1", remoteUserId: "ou-1" },
    channel: { id: conversationKey, kind: "thread" },
    segments: [{ type: "text", text: messageId }],
    plainText: messageId,
    mentions: { selfMentioned: false, users: [] },
    timestamp,
    raw: {},
  } satisfies NormalizedInboundEvent
}

describe("active conversation history recovery", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await getDb().connectorConversationStates.put({
      conversationKey: TARGET.address.conversationKey,
      adapterId: "lk-1",
      activationStatus: "active",
      expiresAt: 200_000,
      deliveryReadiness: "all_messages_verified",
      deliveryTarget: TARGET,
      historyCursor: { afterTimestamp: 10_000 },
      createdAt: 1,
      updatedAt: 1,
    })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("uses the persisted target, filters scope, executes up to the limit, and checkpoints time", async () => {
    const fetchHistoryPage = jest.fn(async () => ({
      events: [
        event("old", 20_000),
        event("recent-1", 90_000),
        {
          ...event("bot", 92_000),
          sender: {
            ...event("bot", 92_000).sender,
            remoteUserId: "cli_other_bot",
            kind: "bot" as const,
          },
        },
        event("wrong", 95_000, "lark:lk-1:oc-1:omt-2"),
        event("recent-2", 100_000),
      ],
    }))
    const dispatched: string[] = []
    const result = await recoverActiveConversationHistory(
      {
        listAdapters: () => [
          {
            id: "lk-1",
            fetchHistoryPage,
          } as unknown as PlatformAdapter,
        ],
        dispatchBackfilledInbound: async (value) => {
          dispatched.push(value.messageId)
        },
      },
      { now: 110_000, catchupMs: 30_000, executionLimit: 1 }
    )

    expect(fetchHistoryPage).toHaveBeenCalledWith(
      TARGET,
      { kind: "timestamp", afterTimestamp: 10_000 },
      { max: 50 }
    )
    expect(dispatched).toEqual(["recent-1"])
    expect(result).toEqual({ conversations: 1, executed: 1, historyOnly: 3 })
    expect(await getDb().connectorInboundJobs.where("status").equals("history_only").count()).toBe(
      3
    )
    expect(await getDb().connectorConversationStates.get(TARGET.address.conversationKey)).toEqual(
      expect.objectContaining({ historyCursor: { afterTimestamp: 100_000 } })
    )
  })
})
