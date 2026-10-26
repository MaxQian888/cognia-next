import type { OutboundRequest } from "@/types/connectors"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"

import {
  PluginDestinationError,
  pluginDestination,
  type PluginDestinationDeps,
} from "./plugin-destination"

const KEY = "lark:bot-a:oc_1"

const STORED: ConversationDeliveryTarget = {
  address: {
    conversationKey: KEY,
    platform: "lark",
    adapterId: "bot-a",
    scopeKind: "group",
    containerId: "oc_1",
  },
  conversationRef: { platform: "lark", adapterId: "bot-a", channelId: "oc_1" },
  sourceMessageId: "om_last",
  refreshedAt: 1,
}

function request(extra: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: { platform: "lark", adapterId: "bot-a", receiveId: "ou_someone_else" },
    segments: [{ type: "text", text: "hello" }],
    metadata: { idempotencyKey: "k1" },
    ...extra,
  }
}

function deps(extra: Partial<PluginDestinationDeps> = {}): Partial<PluginDestinationDeps> {
  return {
    storedTarget: async (key) => (key === KEY ? STORED : undefined),
    messageInConversation: async (_adapter, key, id) => key === KEY && id === "om_here",
    ...extra,
  }
}

async function problemOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(PluginDestinationError)
    return (error as PluginDestinationError).problem
  }
}

describe("pluginDestination (ADR-0239)", () => {
  it("sends to the stored target, never to the plugin's own reference", async () => {
    await expect(pluginDestination("bot-a", KEY, request(), deps())).resolves.toEqual({
      ...request(),
      conversationRef: STORED.conversationRef,
      deliveryTarget: STORED,
    })
  })

  it("replaces a delivery target the plugin built for the same conversation", async () => {
    const own = { ...STORED, conversationRef: { platform: "lark", adapterId: "bot-a", x: 1 } }
    const result = await pluginDestination("bot-a", KEY, request({ deliveryTarget: own }), deps())
    expect(result.deliveryTarget).toBe(STORED)
  })

  it("refuses a malformed key, or another bot's", async () => {
    expect(await problemOf(pluginDestination("bot-a", "nope", request(), deps()))).toBe(
      "invalid-key"
    )
    expect(await problemOf(pluginDestination("bot-b", KEY, request(), deps()))).toBe("invalid-key")
  })

  it("refuses a delivery target that names another conversation or bot", async () => {
    const elsewhere = {
      ...STORED,
      address: { ...STORED.address, conversationKey: "lark:bot-a:oc_2" },
    }
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request({ deliveryTarget: elsewhere }), deps())
      )
    ).toBe("target-mismatch")
    const otherBot = { ...STORED, address: { ...STORED.address, adapterId: "bot-b" } }
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request({ deliveryTarget: otherBot }), deps())
      )
    ).toBe("target-mismatch")
  })

  it("refuses a conversation with no stored target, or a stored one of another bot", async () => {
    expect(await problemOf(pluginDestination("bot-a", "lark:bot-a:oc_9", request(), deps()))).toBe(
      "unknown-conversation"
    )
    const misfiled = { ...STORED, address: { ...STORED.address, adapterId: "bot-b" } }
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request(), deps({ storedTarget: async () => misfiled }))
      )
    ).toBe("unknown-conversation")
  })

  it("keeps a reply or edit of this conversation's message, and refuses any other", async () => {
    await expect(
      pluginDestination("bot-a", KEY, request({ replyTo: { messageId: "om_here" } }), deps())
    ).resolves.toMatchObject({ replyTo: { messageId: "om_here" } })
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request({ replyTo: { messageId: "om_there" } }), deps())
      )
    ).toBe("foreign-message")
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request({ editTargetMessageId: "om_there" }), deps())
      )
    ).toBe("foreign-message")
  })

  it("names the conversation and the problem in its message", async () => {
    await expect(
      pluginDestination("bot-a", "lark:bot-a:oc_9", request(), deps())
    ).rejects.toMatchObject({
      code: "connector_delivery_destination",
      conversationKey: "lark:bot-a:oc_9",
      message: expect.stringContaining("bootstrapConversation"),
    })
  })
})
