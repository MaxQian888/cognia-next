/**
 * @jest-environment jsdom
 */
import type { NormalizedInboundEvent } from "@/types/connectors/event"

import {
  CONNECTOR_MESSAGE_ADDED_TOPIC,
  __resetHostEventsForTests,
  buildConnectorMessageAddedPayload,
  configureHostEvents,
  publishInboundMessageAdded,
  type ConnectorMessageAddedPayload,
} from "./host-events"

const INPUT = { sessionId: "s-1", messageId: "m-local-1" }

function event(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    selfId: "bot-9",
    messageId: "m-remote-1",
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    conversationKey: "telegram:tg-1:555",
    sender: { remoteUserId: "u-1", displayName: "Ada" },
    channel: { kind: "group", name: "ops" },
    segments: [{ type: "text", text: "ping" }],
    plainText: "ping",
    mentions: {},
    timestamp: 1,
    raw: {},
    ...over,
  } as NormalizedInboundEvent
}

let published: Array<{ topic: string; payload: ConnectorMessageAddedPayload }> = []

function install(over: { viewing?: boolean; silenced?: boolean; publish?: jest.Mock } = {}): void {
  configureHostEvents({
    publish:
      over.publish ??
      ((topic: string, payload: ConnectorMessageAddedPayload) => {
        published.push({ topic, payload })
      }),
    isViewingConversation: () => over.viewing ?? false,
    isSilenced: async () => over.silenced ?? false,
  })
}

beforeEach(() => {
  published = []
  __resetHostEventsForTests()
  install()
})

afterEach(() => __resetHostEventsForTests())

describe("buildConnectorMessageAddedPayload", () => {
  it("carries ids and a deep link, never the message text", () => {
    const payload = buildConnectorMessageAddedPayload(event(), INPUT)
    expect(payload).toEqual({
      conversationKey: "telegram:tg-1:555",
      sessionId: "s-1",
      adapterId: "tg-1",
      messageId: "m-local-1",
      href: "/inbox/c?key=telegram%3Atg-1%3A555",
      senderName: "Ada",
      platform: "telegram",
      source: "connector",
    })
    // The frame transits APNs/FCM; the body is built on the Rust side from
    // sender + platform only.
    expect(JSON.stringify(payload)).not.toContain("ping")
  })

  it("percent-encodes the conversation key into the href", () => {
    const payload = buildConnectorMessageAddedPayload(
      event({ conversationKey: "slack:sl 1:C/1?x=2" }),
      INPUT
    )
    expect(payload.href).toBe("/inbox/c?key=slack%3Asl%201%3AC%2F1%3Fx%3D2")
  })

  it("omits a display name the adapter could not resolve", () => {
    const payload = buildConnectorMessageAddedPayload(
      event({ sender: { remoteUserId: "u-1" } as never }),
      INPUT
    )
    expect(payload.senderName).toBeUndefined()
    expect(payload.platform).toBe("telegram")
  })
})

describe("publishInboundMessageAdded", () => {
  it("publishes on the relay topic for a notifiable message", async () => {
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0].topic).toBe(CONNECTOR_MESSAGE_ADDED_TOPIC)
    expect(published[0].payload.messageId).toBe("m-local-1")
  })

  it("reuses the shared notifiability predicate", async () => {
    // Edits, deletes and the bot's own echoes are the desktop Notification
    // Center's rules; the relay must not disagree with them.
    await expect(publishInboundMessageAdded(event({ kind: "edit" }), INPUT)).resolves.toBe(false)
    await expect(publishInboundMessageAdded(event({ plainText: " " }), INPUT)).resolves.toBe(false)
    await expect(
      publishInboundMessageAdded(event({ sender: { remoteUserId: "bot-9" } as never }), INPUT)
    ).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })

  it("stays quiet while the operator is looking at the conversation", async () => {
    install({ viewing: true })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })

  it("stays quiet when the conversation is muted or inside quiet hours", async () => {
    install({ silenced: true })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })

  it("never throws — a lost notification must not roll back the message write", async () => {
    install({
      publish: jest.fn(() => {
        throw new Error("bridge down")
      }),
    })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
  })

  it("swallows a rejected async publisher", async () => {
    install({ publish: jest.fn(() => Promise.reject(new Error("ws closed"))) })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
  })

  it("swallows a throwing suppression check rather than dropping every message", async () => {
    configureHostEvents({
      publish: (topic: string, payload: ConnectorMessageAddedPayload) => {
        published.push({ topic, payload })
      },
      isViewingConversation: () => false,
      isSilenced: async () => {
        throw new Error("dexie closed")
      },
    })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
  })
})

describe("configureHostEvents", () => {
  it("restores the previous seams", async () => {
    const restore = configureHostEvents({ isViewingConversation: () => true })
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(false)
    restore()
    await expect(publishInboundMessageAdded(event(), INPUT)).resolves.toBe(true)
  })
})
