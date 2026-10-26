const isInboundRecorded = jest.fn(async (..._a: unknown[]) => false)
jest.mock("@/lib/db/inbound-ledger", () => ({
  isInboundRecorded: (...a: unknown[]) => isInboundRecorded(...a),
}))
const wasDeliveredByUs = jest.fn(async (..._a: unknown[]) => false)
jest.mock("./delivered-messages", () => ({
  wasDeliveredByUs: (...a: unknown[]) => wasDeliveredByUs(...a),
}))
let storedRows: Array<{ platformMessageId: string; metadata?: unknown }> = []
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: {
      where: () => ({
        equals: (id: string) => ({
          toArray: async () => storedRows.filter((row) => row.platformMessageId === id),
        }),
      }),
    },
  }),
}))
const messageRoute = jest.fn()
let liveAdapter: { messageRoute?: typeof messageRoute } | undefined
jest.mock("./bus", () => ({ getBus: () => ({ getAdapter: () => liveAdapter }) }))
jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(),
}))
jest.mock("./session-bindings", () => ({ findSessionByConversationKey: jest.fn() }))

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
    messageRoute: async ({ conversationKey, messageId }) =>
      conversationKey !== KEY ? "unknown" : messageId === "om_here" ? "within" : "elsewhere",
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

  it("refuses a message nothing can place, and asks with the stored reference", async () => {
    const route = jest.fn(async () => "unknown" as const)
    expect(
      await problemOf(
        pluginDestination(
          "bot-a",
          KEY,
          request({ editTargetMessageId: "om_old" }),
          deps({ messageRoute: route })
        )
      )
    ).toBe("unplaced-message")
    expect(route).toHaveBeenCalledWith({
      adapterId: "bot-a",
      conversationKey: KEY,
      messageId: "om_old",
      use: "edit",
      conversationRef: STORED.conversationRef,
    })
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

describe("pluginDestination: placing a message id (ADR-0239)", () => {
  const stored = { storedTarget: async () => STORED }
  const reply = (messageId: string) => request({ replyTo: { messageId } })

  beforeEach(() => {
    isInboundRecorded.mockReset().mockResolvedValue(false)
    wasDeliveredByUs.mockReset().mockResolvedValue(false)
    messageRoute.mockReset()
    storedRows = []
    liveAdapter = { messageRoute }
  })

  it("places an id the ledger saw in the conversation, without asking the adapter", async () => {
    isInboundRecorded.mockResolvedValue(true)
    await expect(pluginDestination("bot-a", KEY, reply("om_1"), stored)).resolves.toBeDefined()
    wasDeliveredByUs.mockResolvedValue(true)
    isInboundRecorded.mockResolvedValue(false)
    await expect(pluginDestination("bot-a", KEY, reply("om_2"), stored)).resolves.toBeDefined()
    expect(isInboundRecorded).toHaveBeenCalledWith("bot-a", "om_1", "inbound", KEY)
    expect(wasDeliveredByUs).toHaveBeenCalledWith("bot-a", KEY, "om_2")
    expect(messageRoute).not.toHaveBeenCalled()
  })

  it("places an id aged out of the ledger by the message stored for this bot and chat", async () => {
    storedRows = [
      {
        platformMessageId: "om_old",
        // Received in a thread of the same chat.
        metadata: { platformMessage: { adapterId: "bot-a", conversationKey: `${KEY}:omt_1` } },
      },
    ]
    await expect(pluginDestination("bot-a", KEY, reply("om_old"), stored)).resolves.toBeDefined()
    expect(messageRoute).not.toHaveBeenCalled()
  })

  it("does not count a stored message of another bot, another chat, or no recorded scope", async () => {
    messageRoute.mockResolvedValue("unknown")
    for (const platformMessage of [
      { adapterId: "bot-b", conversationKey: "lark:bot-b:oc_1" },
      { adapterId: "bot-a", conversationKey: "lark:bot-a:oc_2" },
      {},
    ]) {
      storedRows = [{ platformMessageId: "om_x", metadata: { platformMessage } }]
      expect(await problemOf(pluginDestination("bot-a", KEY, reply("om_x"), stored))).toBe(
        "unplaced-message"
      )
    }
  })

  it("asks the running adapter last, and follows its answer", async () => {
    messageRoute.mockResolvedValueOnce("within")
    await expect(pluginDestination("bot-a", KEY, reply("om_a"), stored)).resolves.toBeDefined()
    expect(messageRoute).toHaveBeenCalledWith("om_a", "reply", STORED.conversationRef)

    messageRoute.mockResolvedValueOnce("elsewhere")
    expect(await problemOf(pluginDestination("bot-a", KEY, reply("om_b"), stored))).toBe(
      "foreign-message"
    )
    messageRoute.mockRejectedValueOnce(new Error("network"))
    expect(await problemOf(pluginDestination("bot-a", KEY, reply("om_c"), stored))).toBe(
      "unplaced-message"
    )
  })

  it("cannot place an id when the bot is not running or cannot answer", async () => {
    liveAdapter = undefined
    expect(await problemOf(pluginDestination("bot-a", KEY, reply("om_d"), stored))).toBe(
      "unplaced-message"
    )
    liveAdapter = {}
    expect(await problemOf(pluginDestination("bot-a", KEY, reply("om_d"), stored))).toBe(
      "unplaced-message"
    )
  })
})
