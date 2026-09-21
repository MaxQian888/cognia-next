/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { getExecutionRunBinding } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"

import { bindImPresentationForBotDelivery, botImPresentationBindingId } from "./im-presentation"

const NOW = 1_700_000_000_000

function target(overrides: Partial<ConversationDeliveryTarget> = {}): ConversationDeliveryTarget {
  return {
    address: {
      conversationKey: "lark:adp_1:oc_chat",
      platform: "lark",
      adapterId: "adp_1",
      scopeKind: "group",
      containerId: "oc_chat",
    },
    conversationRef: { platform: "lark", adapterId: "adp_1", chatId: "oc_chat" },
    sourceMessageId: "om_src",
    refreshedAt: NOW,
    ...overrides,
  }
}

function envelope(overrides: Partial<BotEventEnvelopeV1> = {}): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "connector",
    type: "connector.inbound",
    installationId: "boti_1",
    triggerId: "ask",
    occurredAt: NOW,
    receivedAt: NOW,
    binding: { adapterId: "adp_1", conversationKey: "lark:adp_1:oc_chat" },
    payload: { messageId: "om_src", plainText: "hi", deliveryTarget: target() },
    provenance: { selfProduced: false, depth: 0 },
    actor: { kind: "human", id: "ou_user", displayName: "Ada" },
    ...overrides,
  }
}

async function deliveryOf(env: BotEventEnvelopeV1): Promise<BotEventDeliveryRow> {
  return enqueueBotDelivery({ envelope: env, now: NOW })
}

beforeEach(async () => {
  __resetDbForTesting()
  const db = getDb()
  await db.botEventDeliveries.clear()
  await db.executionRunBindings.clear()
})

describe("bindImPresentationForBotDelivery", () => {
  it("binds an IM-originated delivery's run to its conversation", async () => {
    const delivery = await deliveryOf(envelope())

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")

    const binding = await getExecutionRunBinding(
      botImPresentationBindingId("run_bot_bdl_1", "adp_1", "lark:adp_1:oc_chat")
    )
    expect(binding).toMatchObject({
      runId: "run_bot_bdl_1",
      adapterId: "adp_1",
      conversationKey: "lark:adp_1:oc_chat",
      status: "active",
      deliveryMode: "native",
      sourceMessageId: "om_src",
      recipientUserId: "ou_user",
      deliveryTarget: target(),
    })
  })

  it("is idempotent across a delivery re-entry", async () => {
    const delivery = await deliveryOf(envelope())

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")
    const first = await getExecutionRunBinding(
      botImPresentationBindingId("run_bot_bdl_1", "adp_1", "lark:adp_1:oc_chat")
    )
    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")
    const second = await getExecutionRunBinding(
      botImPresentationBindingId("run_bot_bdl_1", "adp_1", "lark:adp_1:oc_chat")
    )

    expect(second?.createdAt).toBe(first?.createdAt)
    expect(await getDb().executionRunBindings.count()).toBe(1)
  })

  it("does nothing for a non-IM delivery (no binding fields)", async () => {
    const delivery = await deliveryOf(
      envelope({ binding: undefined, payload: { number: 42 }, actor: undefined })
    )

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")

    expect(await getDb().executionRunBindings.count()).toBe(0)
  })

  it("does nothing when the payload carries no delivery target", async () => {
    const delivery = await deliveryOf(envelope({ payload: { messageId: "om_src" } }))

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")

    expect(await getDb().executionRunBindings.count()).toBe(0)
  })

  it("refuses a target that names a different conversation than the routing binding", async () => {
    const delivery = await deliveryOf(
      envelope({
        payload: {
          deliveryTarget: target({
            address: {
              conversationKey: "lark:adp_1:oc_other",
              platform: "lark",
              adapterId: "adp_1",
              scopeKind: "group",
              containerId: "oc_other",
            },
          }),
        },
      })
    )

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")

    expect(await getDb().executionRunBindings.count()).toBe(0)
  })

  it("falls back to the payload's messageId as the source anchor", async () => {
    const delivery = await deliveryOf(
      envelope({
        payload: {
          messageId: "om_fallback",
          deliveryTarget: target({ sourceMessageId: undefined }),
        },
      })
    )

    await bindImPresentationForBotDelivery(delivery, "run_bot_bdl_1")

    const binding = await getExecutionRunBinding(
      botImPresentationBindingId("run_bot_bdl_1", "adp_1", "lark:adp_1:oc_chat")
    )
    expect(binding?.sourceMessageId).toBe("om_fallback")
  })
})
