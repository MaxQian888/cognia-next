/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import {
  admitConversationEvent,
  evaluateAdmissionPolicy,
  DEFAULT_TOPIC_ACTIVATION_TTL_MS,
  resolveActivationTtlMs,
  resolveDeliveryReadiness,
  resolveInboundActivationPolicy,
} from "./conversation-admission"
import { shouldRespondToMessage } from "./at-gate"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

function event(options: {
  mentioned: boolean
  thread?: boolean
  messageId?: string
  replyParentSenderId?: string
}) {
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
    ...(options.replyParentSenderId !== undefined
      ? {
          replyTo: {
            messageId: "om-parent",
            snippet: "…",
            parentSenderId: options.replyParentSenderId,
          },
        }
      : {}),
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
      mediaModelPolicy: "local_extract_only",
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

  it("admits an unmentioned group reply to one of OUR messages (reply is a direct address)", async () => {
    // The `reply-to-bot` trigger rule can only fire if admission lets the
    // event through: `mention_each` is the default policy, so a reply that is
    // not also an @-mention has to be admitted here or the rule is dormant.
    const adapter = { id: "lk-1", type: "lark", inboundActivationPolicy: "mention_each" } as never

    await expect(
      admitConversationEvent(
        event({ mentioned: false, thread: false, replyParentSenderId: "bot" }),
        adapter,
        { now: 1_000 }
      )
    ).resolves.toEqual({ allowed: true, activated: false })
  })

  it("still requires a mention for a reply to somebody else's message", async () => {
    const adapter = { id: "lk-1", type: "lark", inboundActivationPolicy: "mention_each" } as never

    await expect(
      admitConversationEvent(
        event({ mentioned: false, thread: false, replyParentSenderId: "u-9" }),
        adapter,
        { now: 1_000 }
      )
    ).resolves.toEqual({ allowed: false, reason: "at_mention_required", activated: false })
  })

  it("activates a verified topic on a reply to us, exactly as it does on a mention", async () => {
    const adapter = {
      id: "lk-1",
      type: "lark",
      inboundActivationPolicy: "mention_activates",
      deliveryReadiness: "all_messages_verified",
    } as never

    await expect(
      admitConversationEvent(event({ mentioned: false, replyParentSenderId: "bot" }), adapter, {
        now: 1_000,
      })
    ).resolves.toEqual({ allowed: true, activated: true })
    const state = await getConnectorConversationState("lark:lk-1:oc-1:omt-1")
    expect(state?.activationStatus).toBe("active")
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

// ---------------------------------------------------------------------------
// evaluateAdmissionPolicy: the half both callers share
// ---------------------------------------------------------------------------

describe("evaluateAdmissionPolicy", () => {
  const row = (over: Partial<AdapterInstanceRow> = {}) =>
    ({ type: "lark", ...over }) as AdapterInstanceRow

  it("admits a private chat before the policy is consulted, direct_only included", () => {
    const dm = { ...event({ mentioned: false }), channel: { id: "c", kind: "private" } }
    expect(
      evaluateAdmissionPolicy({
        event: dm as never,
        adapter: row({ inboundActivationPolicy: "direct_only" }),
      })
    ).toEqual({ kind: "allow" })
  })

  it("names activation state as its own outcome rather than guessing", () => {
    // This is the whole reason the function exists: a pure caller cannot see
    // the window, so it has to be told that the window is what decides.
    expect(
      evaluateAdmissionPolicy({
        event: event({ mentioned: false, thread: true }) as never,
        adapter: row({
          inboundActivationPolicy: "mention_activates",
          deliveryReadiness: "all_messages_verified",
        }),
      })
    ).toEqual({ kind: "consult-activation" })
  })

  it("separates admitting from activating", () => {
    expect(
      evaluateAdmissionPolicy({
        event: event({ mentioned: true, thread: true }) as never,
        adapter: row({
          inboundActivationPolicy: "mention_activates",
          deliveryReadiness: "all_messages_verified",
        }),
      })
    ).toEqual({ kind: "allow-and-activate" })
  })

  // The bug this guards: the two switches were hand-mirrored, so a branch
  // added to one silently disagreed with the other. Every stateless case has
  // to produce the same verdict on both sides.
  it("agrees with the pure predictor on every stateless case", () => {
    const policies = ["always", "mention_each", "mention_activates", "direct_only"] as const
    const cases = [
      { mentioned: true, thread: true },
      { mentioned: false, thread: true },
      { mentioned: true, thread: false },
      { mentioned: false, thread: false },
    ]
    for (const policy of policies) {
      for (const verified of [true, false]) {
        for (const c of cases) {
          const adapter = row({
            inboundActivationPolicy: policy,
            ...(verified ? { deliveryReadiness: "all_messages_verified" as const } : {}),
          })
          const ev = event(c)
          const pure = shouldRespondToMessage(ev as never, adapter)
          const outcome = evaluateAdmissionPolicy({ event: ev as never, adapter })
          // `consult-activation` is the one place they legitimately differ.
          // The predictor answers conservatively and names the deciding state.
          const expected =
            outcome.kind === "deny"
              ? { allowed: false, reason: outcome.reason }
              : outcome.kind === "consult-activation"
                ? { allowed: false, reason: "topic_activation_required" }
                : { allowed: true }
          expect({ policy, verified, ...c, ...pure }).toEqual({
            policy,
            verified,
            ...c,
            ...expected,
          })
        }
      }
    }
  })
})
