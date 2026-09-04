/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  claimBotDelivery,
  enqueueBotDelivery,
  markBotDeliveryRunning,
} from "@/lib/db/bot-event-deliveries"
import { installBot, updateBotInstallation } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { drainBotDeliveries, startBotDeliveryRunner } from "./delivery-runner"
import { __resetLiveBotRunsForTesting } from "./run"

const NOW = 1_700_000_000_000
const now = () => NOW

function envelope(overrides: Partial<BotEventEnvelopeV1> = {}): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    provenance: { selfProduced: false, depth: 0 },
    ...overrides,
  }
}

async function seedInstallation(handler = jest.fn()) {
  const definition: PluginBotDef = {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "opened", kind: "manual" }],
  } as PluginBotDef
  registerBot("digest", { id: "acme:digest", definition, handler }, { pluginId: "acme" })
  return installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  __resetLiveBotRunsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
  await db.botRunSteps.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
}, 15_000)

describe("drainBotDeliveries", () => {
  it("does nothing when nothing is due", async () => {
    expect(await drainBotDeliveries({ owner: "host-a", now })).toEqual([])
  })

  it("runs a due delivery and reports the outcome", async () => {
    const handler = jest.fn().mockResolvedValue({ summary: "done" })
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    const attempts = await drainBotDeliveries({ owner: "host-a", now })

    expect(attempts).toHaveLength(1)
    expect(attempts[0].outcome.status).toBe("completed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("skips a delivery another runner already holds", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await claimBotDelivery("bdl_1", "host-b", NOW)

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts).toEqual([])
  })

  it("dismisses a delivery whose installation is gone", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await getDb().botInstallations.delete("boti_1")

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts[0].outcome).toEqual({ status: "skipped", reason: "not_runnable" })
    expect((await getDb().botEventDeliveries.get("bdl_1"))?.status).toBe("dismissed")
  })

  it("dismisses rather than retries when the installation is disabled", async () => {
    await seedInstallation()
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })
    await updateBotInstallation("boti_1", { status: "disabled" })

    // Waiting will not make a disabled installation runnable.
    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts[0].outcome).toEqual({ status: "skipped", reason: "not_runnable" })
  })

  it("serialises deliveries that share a concurrency key", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({
      envelope: envelope(),
      concurrencyKey: "repo#1",
      now: NOW,
    })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo#1",
      now: NOW,
    })
    // Something else is already in flight on that key.
    await claimBotDelivery("bdl_1", "host-b", NOW)
    await markBotDeliveryRunning("bdl_1", "run_x", NOW)

    const attempts = await drainBotDeliveries({ owner: "host-a", now })
    expect(attempts.map((a) => a.outcome)).toEqual([{ status: "skipped", reason: "serialised" }])
    expect(handler).not.toHaveBeenCalled()
  })

  it("runs deliveries with different concurrency keys in the same pass", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), concurrencyKey: "repo#1", now: NOW })
    await enqueueBotDelivery({
      envelope: envelope({ eventId: "bev_2", deliveryId: "bdl_2" }),
      concurrencyKey: "repo#2",
      now: NOW,
    })

    await drainBotDeliveries({ owner: "host-a", now })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("bounds one pass, so one Bot cannot starve the others", async () => {
    await seedInstallation()
    for (let i = 0; i < 4; i++) {
      await enqueueBotDelivery({
        envelope: envelope({ eventId: `bev_${i}`, deliveryId: `bdl_${i}` }),
        now: NOW,
      })
    }

    expect(await drainBotDeliveries({ owner: "host-a", batch: 2, now })).toHaveLength(2)
  })

  it("hands the run the directory the caller resolved", async () => {
    const handler = jest.fn()
    await seedInstallation(handler)
    await enqueueBotDelivery({ envelope: envelope(), now: NOW })

    await drainBotDeliveries({
      owner: "host-a",
      now,
      resolveCwd: () => "/repo",
    })
    expect(handler.mock.calls[0][0].cwd).toBe("/repo")
  })
})

describe("startBotDeliveryRunner", () => {
  it("stops cleanly and idempotently", () => {
    const handle = startBotDeliveryRunner({ owner: "host-a", intervalMs: 10_000, now })
    handle.stop()
    expect(() => handle.stop()).not.toThrow()
  })

  it("keeps looping after a pass throws", async () => {
    // A dead runner is a queue that silently stops draining, so a thrown pass
    // must not kill the loop.
    jest.useFakeTimers()
    const failing = jest
      .spyOn(getDb().botEventDeliveries, "toArray")
      .mockRejectedValueOnce(new Error("transient"))

    const handle = startBotDeliveryRunner({ owner: "host-a", intervalMs: 5, now })
    await jest.advanceTimersByTimeAsync(20)
    expect(failing).toHaveBeenCalled()
    handle.stop()
    jest.useRealTimers()
    failing.mockRestore()
  })
})
