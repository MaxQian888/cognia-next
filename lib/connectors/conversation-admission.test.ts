/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import {
  admitConversationEvent,
  DEFAULT_TOPIC_ACTIVATION_TTL_MS,
  resolveActivationTtlMs,
  resolveDeliveryReadiness,
  resolveInboundActivationPolicy,
} from "./conversation-admission"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

function event(options: { mentioned: boolean; thread?: boolean; messageId?: string }) {
  const thread = options.thread !== false
  const conversationKey = thread ? "lark:lk-1:oc-1:omt-1" : "lark:lk-1:oc-1"
  return {
    platform: "lark",
    adapterId: "lk-1",
    selfId: "bot",
    messageId: options.messageId ?? "om-1",
    conversationRef: {
      platform: "lark",
      adapterId: "lk-1",
      channelId: "oc-1",
      ...(thread ? { threadTs: "omt-1", threadRootMessageId: options.messageId ?? "om-1" } : {}),
    },
    conversationKey,
    conversationAddress: {
      conversationKey,
      platform: "lark",
      adapterId: "lk-1",
      scopeKind: thread ? "thread" : "group",
      containerId: "oc-1",
      ...(thread ? { topicId: "omt-1" } : {}),
    },
    sender: { id: "u-1", platform: "lark", adapterId: "lk-1", remoteUserId: "ou-1" },
    channel: { id: conversationKey, kind: thread ? "thread" : "group" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: options.mentioned, users: options.mentioned ? ["bot"] : [] },
    timestamp: 1_000,
    raw: {},
  } satisfies NormalizedInboundEvent
}

describe("conversation admission", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("maps every legacy at-response strategy explicitly", () => {
    expect(resolveInboundActivationPolicy({ atResponseStrategy: "mention_only" })).toBe(
      "mention_each"
    )
    expect(resolveInboundActivationPolicy({ atResponseStrategy: "always" })).toBe("always")
    expect(resolveInboundActivationPolicy({ atResponseStrategy: "direct_only" })).toBe(
      "direct_only"
    )
  })

  it("uses verified adapter readiness when the topic state is still unknown", () => {
    expect(resolveDeliveryReadiness("unknown", "all_messages_verified")).toBe(
      "all_messages_verified"
    )
    expect(resolveDeliveryReadiness("mentions_only", "all_messages_verified")).toBe("mentions_only")
    expect(resolveDeliveryReadiness(undefined, undefined)).toBe("unknown")
  })

  it("resolves activation TTL using explicit, topic, adapter, then default precedence", () => {
    expect(resolveActivationTtlMs({ activationTtlMs: 30 }, { activationTtlMs: 20 }, 10)).toBe(10)
    expect(resolveActivationTtlMs({ activationTtlMs: 30 }, { activationTtlMs: 20 })).toBe(20)
    expect(resolveActivationTtlMs({ activationTtlMs: 30 })).toBe(30)
    expect(resolveActivationTtlMs({})).toBe(DEFAULT_TOPIC_ACTIVATION_TTL_MS)
  })

  it("activates a verified topic on mention and accepts direct follow-ups until expiry", async () => {
    const adapter = await createAdapterInstance({
      id: "lk-1",
      type: "lark",
      displayName: "Lark",
      enabled: true,
      transportMode: "forward-ws",
      settings: {},
      credentialsRef: { provider: "keyring", accounts: {} },
      defaultMode: "auto",
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      inboundActivationPolicy: "mention_activates",
      deliveryReadiness: "all_messages_verified",
    } as never)

    await expect(
      admitConversationEvent(event({ mentioned: true }), adapter, { now: 1_000 })
    ).resolves.toEqual(expect.objectContaining({ allowed: true, activated: true }))
    expect(await getConnectorConversationState("lark:lk-1:oc-1:omt-1")).toEqual(
      expect.objectContaining({ activationStatus: "active", activatedBy: "ou-1" })
    )

    await expect(
      admitConversationEvent(event({ mentioned: false, messageId: "om-2" }), adapter, {
        now: 2_000,
      })
    ).resolves.toEqual(expect.objectContaining({ allowed: true }))
  })

  it("does not activate the base group and fails closed before all-message delivery is verified", async () => {
    const adapter = {
      id: "lk-1",
      type: "lark",
      inboundActivationPolicy: "mention_activates",
      deliveryReadiness: "mentions_only",
    } as never

    await expect(
      admitConversationEvent(event({ mentioned: true, thread: false }), adapter, { now: 1_000 })
    ).resolves.toEqual(expect.objectContaining({ allowed: true, activated: false }))
    await expect(
      admitConversationEvent(event({ mentioned: false }), adapter, { now: 2_000 })
    ).resolves.toEqual({ allowed: false, reason: "delivery_unverified", activated: false })
  })

  it("keeps a legacy Lark always policy mention-gated until no-@ delivery is verified", async () => {
    const adapter = {
      id: "lk-1",
      type: "lark",
      atResponseStrategy: "always",
      deliveryReadiness: "mentions_only",
    } as never
    await expect(
      admitConversationEvent(event({ mentioned: false }), adapter, { now: 1_000 })
    ).resolves.toEqual({ allowed: false, reason: "delivery_unverified", activated: false })
    await expect(
      admitConversationEvent(event({ mentioned: true }), adapter, { now: 1_000 })
    ).resolves.toEqual({ allowed: true, activated: false })
  })
})
