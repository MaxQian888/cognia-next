const placeMessageImpl = jest.fn()
jest.mock("./message-placement", () => ({
  ...jest.requireActual("./message-placement"),
  placeMessage: (...a: unknown[]) => placeMessageImpl(...a),
}))
const liveAdapter = { messageRoute: jest.fn() }
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
    placeMessage: async ({ conversationKey, messageId }) =>
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
          deps({ placeMessage: route })
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

describe("pluginDestination: a message that cannot be placed now (ADR-0239)", () => {
  const unavailable = deps({
    placeMessage: async ({ messageId }) => (messageId === "om_here" ? "within" : "unavailable"),
  })

  it("refuses it for a delivery sent at once", async () => {
    expect(
      await problemOf(
        pluginDestination("bot-a", KEY, request({ replyTo: { messageId: "om_x" } }), unavailable)
      )
    ).toBe("unplaced-message")
  })

  it("defers it to just before a queued delivery is sent", async () => {
    const result = await pluginDestination(
      "bot-a",
      KEY,
      request({ replyTo: { messageId: "om_here" }, editTargetMessageId: "om_x" }),
      unavailable,
      { queued: true }
    )
    expect(result.metadata).toEqual({
      idempotencyKey: "k1",
      pendingPlacement: [{ use: "edit", messageId: "om_x" }],
    })
    expect(result.deliveryTarget).toBe(STORED)
  })

  it("still refuses a message placed elsewhere or nowhere when queued", async () => {
    for (const [placement, problem] of [
      ["elsewhere", "foreign-message"],
      ["unknown", "unplaced-message"],
    ] as const) {
      expect(
        await problemOf(
          pluginDestination(
            "bot-a",
            KEY,
            request({ replyTo: { messageId: "om_x" } }),
            deps({ placeMessage: async () => placement }),
            { queued: true }
          )
        )
      ).toBe(problem)
    }
  })

  it("places and returns one copy, whatever the plugin changes while it waits", async () => {
    let release!: () => void
    const placed = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: string[] = []
    const own = request({ replyTo: { messageId: "om_here" } })
    const pending = pluginDestination(
      "bot-a",
      KEY,
      own,
      deps({
        placeMessage: async ({ messageId }) => {
          seen.push(messageId)
          await placed
          return messageId === "om_here" ? "within" : "elsewhere"
        },
      }),
      { queued: true }
    )
    await Promise.resolve()
    own.replyTo!.messageId = "om_foreign"
    own.editTargetMessageId = "om_foreign"
    own.metadata.pendingPlacement = []
    release()
    const result = await pending
    expect(seen).toEqual(["om_here"])
    expect(result.replyTo).toEqual({ messageId: "om_here" })
    expect(result).not.toHaveProperty("editTargetMessageId")
    expect(result.metadata).toEqual({ idempotencyKey: "k1" })
  })

  it("drops a pending placement the plugin set itself", async () => {
    const own = request({
      metadata: { idempotencyKey: "k1", pendingPlacement: [{ use: "reply", messageId: "om_y" }] },
    })
    const result = await pluginDestination("bot-a", KEY, own, deps(), { queued: true })
    expect(result.metadata).toEqual({ idempotencyKey: "k1" })
  })
})

describe("pluginDestination: default placement (ADR-0239)", () => {
  it("places through the running adapter on the bus", async () => {
    placeMessageImpl.mockReset().mockResolvedValue("within")
    await expect(
      pluginDestination("bot-a", KEY, request({ replyTo: { messageId: "om_a" } }), {
        storedTarget: async () => STORED,
      })
    ).resolves.toBeDefined()
    const [placed, placementDeps] = placeMessageImpl.mock.calls[0] as [
      unknown,
      { getAdapter(id: string): Promise<unknown> },
    ]
    expect(placed).toEqual({
      use: "reply",
      messageId: "om_a",
      adapterId: "bot-a",
      conversationKey: KEY,
      conversationRef: STORED.conversationRef,
    })
    await expect(placementDeps.getAdapter("bot-a")).resolves.toBe(liveAdapter)
  })
})
