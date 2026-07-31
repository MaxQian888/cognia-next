import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { createConnectorLiveSteerCoordinator } from "./live-steer"

function event(messageId = "m-steer"): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lark-1",
    selfId: "bot-1",
    messageId,
    conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "chat-1" },
    conversationKey: "lark:lark-1:chat-1",
    sender: {
      id: "identity-2",
      platform: "lark",
      adapterId: "lark-1",
      remoteUserId: "ou-2",
      displayName: "Second participant",
    },
    channel: { id: "chat-1", kind: "private" },
    segments: [{ type: "text", text: "change direction" }],
    plainText: "change direction",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 10,
    raw: {},
  }
}

describe("connector live-steer coordinator", () => {
  it("stores the real sender message before acknowledging live sidecar input", async () => {
    const order: string[] = []
    const storeInbound = jest.fn(async () => {
      order.push("store")
    })
    const steer = jest.fn(async () => {
      order.push("steer")
      return { accepted: true as const }
    })
    const admit = jest.fn(async () => {
      order.push("admit")
      return true
    })
    const coordinator = createConnectorLiveSteerCoordinator({ storeInbound, admit, steer })
    const deactivate = coordinator.activate({
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-1",
      executionRunId: "run-1",
      provider: "anthropic",
    })

    await expect(coordinator.handle(event())).resolves.toEqual({
      activeRun: true,
      accepted: true,
      executionRunId: "run-1",
    })
    expect(order).toEqual(["store", "admit", "steer"])
    expect(storeInbound).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m-steer" }),
      "session-1"
    )
    expect(steer).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ messageId: "m-steer", plainText: "change direction" })
    )

    deactivate()
    await expect(coordinator.handle(event("m-late"))).resolves.toEqual({
      activeRun: false,
      accepted: false,
    })
  })

  it("preserves a durable replay when provider or sidecar cannot acknowledge", async () => {
    const storeInbound = jest.fn(async () => undefined)
    const steer = jest.fn(async () => {
      throw new Error("input_closed")
    })
    const admit = jest.fn(async () => true)
    const coordinator = createConnectorLiveSteerCoordinator({ storeInbound, admit, steer })
    coordinator.activate({
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-1",
      executionRunId: "run-1",
      provider: "anthropic",
    })

    await expect(coordinator.handle(event())).resolves.toEqual({
      activeRun: true,
      accepted: false,
      executionRunId: "run-1",
    })

    const unsupported = createConnectorLiveSteerCoordinator({ storeInbound, admit, steer })
    unsupported.activate({
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-2",
      executionRunId: "run-2",
      provider: "openai",
    })
    await expect(unsupported.handle(event("m-openai"))).resolves.toEqual({
      activeRun: true,
      accepted: false,
      executionRunId: "run-2",
    })
    expect(storeInbound).toHaveBeenCalledTimes(1)
  })

  it("keeps the durable job pending when outbound admission rejects the steer", async () => {
    const storeInbound = jest.fn(async () => undefined)
    const admit = jest.fn(async () => false)
    const steer = jest.fn(async () => ({ accepted: true as const }))
    const coordinator = createConnectorLiveSteerCoordinator({ storeInbound, admit, steer })
    coordinator.activate({
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-1",
      executionRunId: "run-1",
      provider: "anthropic",
    })

    await expect(coordinator.handle(event())).resolves.toEqual({
      activeRun: true,
      accepted: false,
      executionRunId: "run-1",
    })
    expect(storeInbound).toHaveBeenCalledTimes(1)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })
})
