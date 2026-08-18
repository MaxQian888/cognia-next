import type { NormalizedInboundEvent } from "@/types/connectors/event"

import { isNotifiableInboundEvent } from "./inbound-notifiability"

function event(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot-9",
    messageId: "m-1",
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:555",
    sender: { remoteUserId: "u-1", displayName: "Ada" },
    channel: { kind: "group", name: "ops" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: {},
    timestamp: 1,
    raw: {},
    ...over,
  } as NormalizedInboundEvent
}

describe("isNotifiableInboundEvent", () => {
  it("accepts a plain inbound message from a human", () => {
    expect(isNotifiableInboundEvent(event())).toBe(true)
  })

  it("accepts an event with no explicit kind (the Phase 1 default is `create`)", () => {
    expect(isNotifiableInboundEvent(event({ kind: undefined }))).toBe(true)
    expect(isNotifiableInboundEvent(event({ kind: "create" }))).toBe(true)
  })

  it.each(["edit", "delete", "system"] as const)("rejects a %s event", (kind) => {
    // The conversation already showed the original; re-notifying would buzz
    // the phone for a typo fix.
    expect(isNotifiableInboundEvent(event({ kind }))).toBe(false)
  })

  it("rejects the bot's own outbound echo", () => {
    // Platforms reflect the bot's own sends back over the gateway. Without
    // this every reply the operator sends would notify their own phone.
    expect(
      isNotifiableInboundEvent(
        event({ sender: { remoteUserId: "bot-9", displayName: "cognia" } as never })
      )
    ).toBe(false)
  })

  it("rejects an event with no previewable text", () => {
    expect(isNotifiableInboundEvent(event({ plainText: "" }))).toBe(false)
    expect(isNotifiableInboundEvent(event({ plainText: "   " }))).toBe(false)
  })

  it("still accepts a message from a sender with no resolved remote id", () => {
    // `selfId` matching is the echo test; an unresolved sender is not an echo.
    expect(
      isNotifiableInboundEvent(event({ sender: { displayName: "Anonymous" } as never }))
    ).toBe(true)
  })
})
