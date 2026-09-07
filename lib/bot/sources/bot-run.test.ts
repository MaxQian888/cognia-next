/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { listBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import { MAX_BOT_EVENT_DEPTH } from "@/lib/bot/events/provenance"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotDef, PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

import { botRunEventType, dispatchBotRunToBots } from "./bot-run"

const NOW = 1_700_000_000_000

function cause(depth = 0): BotEventEnvelopeV1 {
  return {
    eventId: "bev_cause",
    deliveryId: "bdl_cause",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    provenance: { selfProduced: false, depth },
  }
}

async function seed(policyGrant?: PluginBotPolicyV1, id = "boti_1") {
  registerBot(
    id,
    {
      id: `acme:${id}`,
      definition: {
        id,
        name: "Chain",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "echo", kind: "event", source: "bot", types: ["bot.run.completed"] }],
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
    ...(policyGrant ? { policyGrant } : {}),
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

const settled = {
  runId: "run_bot_1",
  installationId: "boti_1",
  botId: "acme:boti_1",
  status: "completed" as const,
}

describe("dispatchBotRunToBots", () => {
  it("refuses to hand a Bot its own run back by default", async () => {
    await seed()

    const result = await dispatchBotRunToBots({ ...settled, cause: cause() })

    expect(result.enqueued).toEqual([])
    expect(result.rejected).toEqual([
      { installationId: "boti_1", triggerId: "echo", reason: "self_produced" },
    ])
  })

  it("delivers once the installation's own ceiling opts in", async () => {
    await seed({ allowSelfTriggering: true })

    expect((await dispatchBotRunToBots({ ...settled, cause: cause() })).enqueued).toHaveLength(1)
  })

  it("still refuses past the depth cap, opt-in or not", async () => {
    await seed({ allowSelfTriggering: true })

    const result = await dispatchBotRunToBots({ ...settled, cause: cause(MAX_BOT_EVENT_DEPTH) })

    expect(result.enqueued).toEqual([])
    expect(result.rejected[0]?.reason).toBe("depth_exceeded")
  })

  it("reaches a DIFFERENT Bot, which is what a chain is", async () => {
    await seed(undefined, "boti_2")

    // Produced by boti_1, so it is not boti_2's own echo.
    expect((await dispatchBotRunToBots({ ...settled, cause: cause() })).enqueued).toHaveLength(1)
  })

  it("carries the causation chain, by id and never by name", async () => {
    await seed(undefined, "boti_2")
    await dispatchBotRunToBots({ ...settled, cause: cause() })

    const [row] = await listBotDeliveries({ installationId: "boti_2" })
    expect(row.envelope.provenance).toMatchObject({
      selfProduced: true,
      producedByRunId: "run_bot_1",
      producedByInstallationId: "boti_1",
      depth: 1,
      causationEventIds: ["bev_cause"],
    })
  })

  it("names both settled states", () => {
    expect(botRunEventType("completed")).toBe("bot.run.completed")
    expect(botRunEventType("failed")).toBe("bot.run.failed")
  })
})
