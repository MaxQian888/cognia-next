/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { CONNECTOR_INBOUND_EVENT_TYPE, dispatchConnectorInboundToBots } from "./connector-inbound"

const NOW = 1_700_000_000_000

function inbound(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "slack",
    adapterId: "adp_1",
    selfId: "bot_self",
    messageId: "m1",
    conversationRef: { platform: "slack", adapterId: "adp_1", chatId: "C1" },
    conversationKey: "slack:adp_1:C1",
    sender: {
      id: "pid_1",
      platform: "slack",
      adapterId: "adp_1",
      remoteUserId: "U123",
      displayName: "Ada",
    },
    channel: { kind: "group", id: "C1" },
    segments: [{ type: "text", text: "ship it" }],
    plainText: "ship it",
    mentions: { selfMentioned: true, users: [] },
    timestamp: NOW,
    raw: { enormous: "platform payload" },
    ...overrides,
  } as NormalizedInboundEvent
}

async function seedInstallation(
  trigger: PluginBotTriggerDef,
  overrides: { id?: string; adapterId?: string } = {}
) {
  const id = overrides.id ?? "boti_1"
  registerBot(
    id,
    {
      id: `acme:${id}`,
      definition: {
        id,
        name: "Watcher",
        version: "1.0.0",
        executor: "handler",
        triggers: [trigger],
      } as PluginBotDef,
      handler: jest.fn(),
    },
    { pluginId: "acme" }
  )
  return installBot({
    id,
    definitionId: `acme:${id}`,
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    ...(overrides.adapterId
      ? { credentialBindings: { chat: { adapterId: overrides.adapterId } } }
      : {}),
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
}, 15_000)

describe("dispatchConnectorInboundToBots", () => {
  it("delivers to an interaction trigger", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" })

    const result = await dispatchConnectorInboundToBots({ event: inbound() })

    expect(result.enqueued).toHaveLength(1)
    expect(result.enqueued[0]).toMatchObject({
      installationId: "boti_1",
      triggerId: "ask",
      source: "connector",
      type: CONNECTOR_INBOUND_EVENT_TYPE,
    })
  })

  it("matches a trigger that narrows by platform", async () => {
    await seedInstallation({ id: "ask", kind: "interaction", adapterTypes: ["slack"] })

    expect((await dispatchConnectorInboundToBots({ event: inbound() })).enqueued).toHaveLength(1)
  })

  it("does not deliver to a trigger narrowed to another platform", async () => {
    await seedInstallation({ id: "ask", kind: "interaction", adapterTypes: ["lark"] })

    expect((await dispatchConnectorInboundToBots({ event: inbound() })).enqueued).toEqual([])
  })

  it("does not deliver to a Bot bound to a different adapter instance", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" }, { adapterId: "adp_other" })

    expect((await dispatchConnectorInboundToBots({ event: inbound() })).enqueued).toEqual([])
  })

  it("leaves an event trigger alone, because this is not its source", async () => {
    await seedInstallation({
      id: "opened",
      kind: "event",
      source: "integration",
      types: [CONNECTOR_INBOUND_EVENT_TYPE],
    })

    expect((await dispatchConnectorInboundToBots({ event: inbound() })).enqueued).toEqual([])
  })

  it("carries what the message says, and not the platform's raw payload", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" })
    await dispatchConnectorInboundToBots({ event: inbound() })

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row.envelope.payload).toEqual({
      platform: "slack",
      conversationKey: "slack:adp_1:C1",
      messageId: "m1",
      plainText: "ship it",
      segments: [{ type: "text", text: "ship it" }],
      channelKind: "group",
      selfMentioned: true,
    })
    expect(JSON.stringify(row.envelope)).not.toContain("enormous")
  })

  it("names the sender without claiming they are a verified Cognia identity", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" })
    await dispatchConnectorInboundToBots({ event: inbound() })

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row.envelope.actor).toEqual({ kind: "human", id: "U123", displayName: "Ada" })
    // An approval's actor scope is derived from `principalId`, so guessing one
    // here would widen who may tap Approve.
    expect(row.envelope.actor?.principalId).toBeUndefined()
  })

  it("passes an adapter-reported bot sender through as a bot", async () => {
    // Provenance only knows what Cognia produced. A sibling bot's message
    // arriving as `human` would be a loop it cannot see.
    await seedInstallation({ id: "ask", kind: "interaction" })
    await dispatchConnectorInboundToBots({
      event: inbound({
        sender: {
          id: "pid_2",
          platform: "slack",
          adapterId: "adp_1",
          remoteUserId: "B999",
          kind: "bot",
        },
      }),
    })

    const [row] = await listBotDeliveries({ installationId: "boti_1" })
    expect(row.envelope.actor?.kind).toBe("bot")
  })

  it("is idempotent for a redelivered message", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" })
    await dispatchConnectorInboundToBots({ event: inbound() })
    await dispatchConnectorInboundToBots({ event: inbound() })

    expect(await listBotDeliveries({ installationId: "boti_1" })).toHaveLength(1)
  })

  it("fans one message out to every installation that wants it", async () => {
    await seedInstallation({ id: "ask", kind: "interaction" })
    await seedInstallation({ id: "ask", kind: "interaction" }, { id: "boti_2" })

    expect((await dispatchConnectorInboundToBots({ event: inbound() })).enqueued).toHaveLength(2)
  })
})
