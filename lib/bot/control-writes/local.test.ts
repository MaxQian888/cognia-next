/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { installBot, getBotInstallation } from "@/lib/db/bot-installations"
import {
  enqueueBotDelivery,
  failBotDelivery,
  getBotDelivery,
  listBotDeliveries,
} from "@/lib/db/bot-event-deliveries"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { __resetDbForTesting } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"

import {
  BotControlTargetMissingError,
  replayBotDeliveryLocally,
  runBotManuallyLocally,
  setBotTriggerArmedLocally,
} from "./local"

const NOW = 1_700_000_000_000

function def(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [
      { id: "run", kind: "manual" },
      { id: "nightly", kind: "schedule", cron: "0 9 * * *", enabledByDefault: false },
    ],
    ...overrides,
  } as PluginBotDef
}

async function install(definition: PluginBotDef = def(), overrides: Record<string, unknown> = {}) {
  registerBot("digest", { id: "acme:digest", definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: definition.version,
    scope: { kind: "account" },
    now: NOW,
    ...overrides,
  })
}

beforeEach(async () => {
  __resetBotsForTesting()
  await __resetDbForTesting()
})

describe("setBotTriggerArmedLocally", () => {
  it("writes an absolute value, so a replayed relay command cannot flip it back", () => {
    // arm, disarm, arm replayed in order lands on armed. Three toggles would
    // land on disarmed, which is why this is "set" and not "toggle".
    return install().then(async (row) => {
      await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: true,
      })
      await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: false,
      })
      const final = await setBotTriggerArmedLocally({
        installationId: row.id,
        triggerId: "nightly",
        armed: true,
      })
      expect(final.triggerOverrides?.nightly).toBe(true)
    })
  })

  it("refuses a trigger the definition does not declare", async () => {
    // An override for an unknown id is silently inert, which is the failure
    // this console exists to stop producing.
    const row = await install()
    await expect(
      setBotTriggerArmedLocally({ installationId: row.id, triggerId: "ghost", armed: true })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("refuses an installation that is gone", async () => {
    await expect(
      setBotTriggerArmedLocally({ installationId: "boti_missing", triggerId: "run", armed: true })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("keeps a needs_setup installation from silently becoming enabled", async () => {
    const row = await install(
      def({ requires: { credentials: [{ id: "token", label: "Token" }] } }),
      { requiredCredentials: [{ id: "token", label: "Token" }] }
    )
    expect(row.status).toBe("needs_setup")

    const next = await setBotTriggerArmedLocally({
      installationId: row.id,
      triggerId: "nightly",
      armed: true,
    })
    expect(next.status).toBe("needs_setup")
  })
})

describe("runBotManuallyLocally", () => {
  it("enqueues a delivery rather than running one, so the queue still serialises", async () => {
    const row = await install()
    const result = await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })

    expect(result.created).toBe(true)
    const queued = await listBotDeliveries({ installationId: row.id })
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ status: "pending", triggerId: "run", type: "manual.run" })
  })

  it("folds a retried command onto one delivery", async () => {
    // The relay replays a queued command after a reconnect. Two runs need two
    // keys, and a retry of one needs the same key.
    const row = await install()
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    expect(await listBotDeliveries({ installationId: row.id })).toHaveLength(1)

    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k2" })
    expect(await listBotDeliveries({ installationId: row.id })).toHaveLength(2)
  })

  it("runs a DISARMED trigger, because pressing Run is the arming", async () => {
    const row = await install()
    const result = await runBotManuallyLocally({
      installationId: row.id,
      triggerId: "nightly",
      idempotencyKey: "k1",
    })
    expect(result.created).toBe(true)
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.triggerId).toBe("nightly")
  })

  it("does not mark itself self-produced, or the loop guard would refuse it", async () => {
    const row = await install()
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.envelope.provenance).toEqual({ selfProduced: false, depth: 0 })
    expect(queued?.envelope.actor).toEqual({ kind: "human" })
  })

  it("refuses when the definition declares no manual trigger and none was named", async () => {
    const row = await install(
      def({ triggers: [{ id: "nightly", kind: "schedule", cron: "* * * * *" }] })
    )
    await expect(
      runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    ).rejects.toBeInstanceOf(BotControlTargetMissingError)
  })

  it("carries the trigger's concurrency key, so it waits its turn", async () => {
    const row = await install(
      def({ triggers: [{ id: "run", kind: "manual", concurrencyKey: "{{type}}" }] })
    )
    await runBotManuallyLocally({ installationId: row.id, idempotencyKey: "k1" })
    const [queued] = await listBotDeliveries({ installationId: row.id })
    expect(queued?.concurrencyKey).toBe(`${row.id}::manual.run`)
  })
})

describe("replayBotDeliveryLocally", () => {
  async function deadLetter(installationId: string) {
    const envelope = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "d7",
      type: "x",
      installationId,
      triggerId: "run",
      occurredAt: NOW,
      payload: {},
    })
    const row = await enqueueBotDelivery({ envelope, now: NOW })
    // Burn every attempt so the queue retires it.
    for (let i = 0; i < 12; i += 1) {
      const current = await getBotDelivery(row.id)
      if (current?.status === "deadletter") break
      await failBotDelivery(row.id, new Error("nope"), NOW)
    }
    return row.id
  }

  it("puts a dead-lettered delivery back on the queue", async () => {
    const install1 = await install()
    const id = await deadLetter(install1.id)
    expect((await getBotDelivery(id))?.status).toBe("deadletter")

    expect(await replayBotDeliveryLocally(id)).toBe(true)
    expect((await getBotDelivery(id))?.status).toBe("pending")
  })

  it("is a no-op the second time, which is what makes a replayed command safe", async () => {
    const install1 = await install()
    const id = await deadLetter(install1.id)
    await replayBotDeliveryLocally(id)
    expect(await replayBotDeliveryLocally(id)).toBe(false)
  })

  it("refuses a delivery that does not exist", async () => {
    await expect(replayBotDeliveryLocally("bdl_missing")).rejects.toBeInstanceOf(
      BotControlTargetMissingError
    )
  })
})

describe("installation reads", () => {
  it("leaves the row readable after every write", async () => {
    const row = await install()
    await setBotTriggerArmedLocally({ installationId: row.id, triggerId: "run", armed: false })
    expect((await getBotInstallation(row.id))?.triggerOverrides).toEqual({ run: false })
  })
})
