const isInboundRecorded = jest.fn(async (..._a: unknown[]) => false)
jest.mock("@/lib/db/inbound-ledger", () => ({
  isInboundRecorded: (...a: unknown[]) => isInboundRecorded(...a),
}))
const wasDeliveredByUs = jest.fn(async (..._a: unknown[]) => false)
jest.mock("./delivered-messages", () => ({
  wasDeliveredByUs: (...a: unknown[]) => wasDeliveredByUs(...a),
  landedChatsOf: async () => [],
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

import { messagePointers, placeMessage, type PlaceMessageInput } from "./message-placement"

const KEY = "lark:bot-a:oc_1"
const REF = { platform: "lark", adapterId: "bot-a", channelId: "oc_1" }

function input(messageId: string, use: "reply" | "edit" = "reply"): PlaceMessageInput {
  return { adapterId: "bot-a", conversationKey: KEY, conversationRef: REF, messageId, use }
}

const messageRoute = jest.fn()
let liveAdapter: { messageRoute?: typeof messageRoute } | undefined
const getAdapter = jest.fn(() => liveAdapter)

beforeEach(() => {
  isInboundRecorded.mockReset().mockResolvedValue(false)
  wasDeliveredByUs.mockReset().mockResolvedValue(false)
  messageRoute.mockReset()
  getAdapter.mockClear()
  storedRows = []
  liveAdapter = { messageRoute }
})

describe("messagePointers", () => {
  it("lists the reply, then the edit, and skips empty ids", () => {
    expect(
      messagePointers({ replyTo: { messageId: "om_r" }, editTargetMessageId: "om_e" })
    ).toEqual([
      { use: "reply", messageId: "om_r" },
      { use: "edit", messageId: "om_e" },
    ])
    expect(messagePointers({ replyTo: { messageId: "" }, editTargetMessageId: "" })).toEqual([])
    expect(messagePointers({})).toEqual([])
  })
})

describe("placeMessage (ADR-0239)", () => {
  it("places an id the ledger saw in the conversation, without asking the adapter", async () => {
    isInboundRecorded.mockResolvedValue(true)
    await expect(placeMessage(input("om_1"), { getAdapter })).resolves.toBe("within")
    isInboundRecorded.mockResolvedValue(false)
    wasDeliveredByUs.mockResolvedValue(true)
    await expect(placeMessage(input("om_2"), { getAdapter })).resolves.toBe("within")
    expect(isInboundRecorded).toHaveBeenCalledWith("bot-a", "om_1", "inbound", KEY)
    expect(wasDeliveredByUs).toHaveBeenCalledWith("bot-a", KEY, "om_2")
    expect(getAdapter).not.toHaveBeenCalled()
  })

  it("places an id aged out of the ledger by the message stored for this bot and chat", async () => {
    storedRows = [
      {
        platformMessageId: "om_old",
        // Received in a thread of the same chat.
        metadata: { platformMessage: { adapterId: "bot-a", conversationKey: `${KEY}:omt_1` } },
      },
    ]
    await expect(placeMessage(input("om_old"), { getAdapter })).resolves.toBe("within")
    expect(getAdapter).not.toHaveBeenCalled()
  })

  it("does not count a stored message of another bot, another chat, or no recorded scope", async () => {
    messageRoute.mockResolvedValue("unknown")
    for (const platformMessage of [
      { adapterId: "bot-b", conversationKey: "lark:bot-b:oc_1" },
      { adapterId: "bot-a", conversationKey: "lark:bot-a:oc_2" },
      {},
    ]) {
      storedRows = [{ platformMessageId: "om_x", metadata: { platformMessage } }]
      await expect(placeMessage(input("om_x"), { getAdapter })).resolves.toBe("unknown")
    }
  })

  it("reads a failing ledger or message store as no evidence", async () => {
    messageRoute.mockResolvedValue("within")
    await expect(
      placeMessage(input("om_y"), {
        getAdapter,
        recorded: async () => Promise.reject(new Error("db")),
        stored: async () => Promise.reject(new Error("db")),
      })
    ).resolves.toBe("within")
    expect(messageRoute).toHaveBeenCalled()
  })

  it("asks the running adapter last, with the delivery's reference, and follows its answer", async () => {
    messageRoute.mockResolvedValueOnce("within")
    await expect(placeMessage(input("om_a", "edit"), { getAdapter })).resolves.toBe("within")
    expect(getAdapter).toHaveBeenCalledWith("bot-a")
    expect(messageRoute).toHaveBeenCalledWith("om_a", "edit", REF, { landedChatIds: [] })
    messageRoute.mockResolvedValueOnce("elsewhere")
    await expect(placeMessage(input("om_b"), { getAdapter })).resolves.toBe("elsewhere")
    messageRoute.mockResolvedValueOnce("unknown")
    await expect(placeMessage(input("om_c"), { getAdapter })).resolves.toBe("unknown")
  })

  it("tells the adapter which chats the conversation's deliveries landed in", async () => {
    messageRoute.mockResolvedValue("within")
    const landed = jest.fn(async () => ["oc_dm"])
    await placeMessage(input("om_l"), { getAdapter, landed })
    expect(landed).toHaveBeenCalledWith("bot-a", KEY)
    expect(messageRoute).toHaveBeenCalledWith("om_l", "reply", REF, { landedChatIds: ["oc_dm"] })
    messageRoute.mockClear()
    await placeMessage(input("om_m"), {
      getAdapter,
      landed: async () => Promise.reject(new Error("db")),
    })
    expect(messageRoute).toHaveBeenCalledWith("om_m", "reply", REF, { landedChatIds: [] })
  })

  it("cannot tell now when the bot is not running, or the platform cannot be asked", async () => {
    messageRoute.mockRejectedValueOnce(new Error("network"))
    await expect(placeMessage(input("om_d"), { getAdapter })).resolves.toBe("unavailable")
    liveAdapter = undefined
    await expect(placeMessage(input("om_d"), { getAdapter })).resolves.toBe("unavailable")
    await expect(
      placeMessage(input("om_d"), {
        getAdapter: async () => Promise.reject(new Error("bus not started")),
      })
    ).resolves.toBe("unavailable")
  })

  it("cannot place an id with a running adapter that has no way to place it", async () => {
    liveAdapter = {}
    await expect(placeMessage(input("om_e"), { getAdapter })).resolves.toBe("unknown")
  })
})
