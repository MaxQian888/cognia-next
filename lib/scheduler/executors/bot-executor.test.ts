/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot, updateBotInstallation, writeBotTriggerState } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

import { executeBotTask } from "./bot-executor"

const NOW = 1_700_000_000_000

function task(payload: Record<string, unknown>): ScheduledTask {
  return { id: "task_1", name: "Digest", type: "bot", payload } as ScheduledTask
}

const execution = {} as TaskExecution
const live = new AbortController().signal

async function seed(triggers: PluginBotTriggerDef[]) {
  const definition: PluginBotDef = {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers,
  } as PluginBotDef
  registerBot("digest", { id: "acme:digest", definition, handler: jest.fn() }, { pluginId: "acme" })
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
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
}, 15_000)

describe("executeBotTask", () => {
  it("refuses a payload that names no installation or trigger", async () => {
    const result = await executeBotTask(task({}), execution, live)
    expect(result.success).toBe(false)
    expect(result.terminalReason).toBe("executor-failure")
  })

  it("enqueues a delivery for a schedule trigger", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      live
    )

    expect(result.success).toBe(true)
    const rows = await getDb().botEventDeliveries.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].envelope.source).toBe("schedule")
    expect(rows[0].envelope.type).toBe("bot.schedule")
  })

  it("gives every tick started by hand its own event, so a second is not deduplicated away", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const payload = task({ installationId: "boti_1", triggerId: "morning" })
    const byHand = { triggerSource: "run-now" } as TaskExecution

    await executeBotTask(payload, byHand, live)
    await executeBotTask(payload, byHand, live)

    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("keys a timed tick on its slot: two slots are two events, one slot fired twice is one", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const payload = task({ installationId: "boti_1", triggerId: "morning" })
    const slot = new Date("2026-10-12T09:00:00.000Z")
    const fire = (scheduledFor: Date, triggerSource: TaskExecution["triggerSource"]) =>
      ({ scheduledFor, triggerSource }) as TaskExecution

    await executeBotTask(payload, fire(slot, "schedule"), live)
    // The same slot again, reached late by the catch-up path.
    await executeBotTask(payload, fire(slot, "catch-up"), live)
    await executeBotTask(payload, fire(new Date(slot.getTime() + 86_400_000), "schedule"), live)

    const rows = await getDb().botEventDeliveries.toArray()
    expect(rows).toHaveLength(2)
    // The event happened at the slot, not when this host fired it.
    expect(rows.map((row) => row.envelope.occurredAt).sort()).toEqual([
      slot.getTime(),
      slot.getTime() + 86_400_000,
    ])
  })

  it("carries the stored cursor to a poll trigger", async () => {
    await seed([{ id: "sweep", kind: "poll", everyMs: 60_000 }])
    await writeBotTriggerState("boti_1", "sweep", { cursor: "page-2" }, NOW)

    await executeBotTask(task({ installationId: "boti_1", triggerId: "sweep" }), execution, live)

    const [row] = await getDb().botEventDeliveries.toArray()
    expect(row.envelope.payload).toMatchObject({ triggerKind: "poll", cursor: "page-2" })
  })

  it("carries the last edge value to a derivedState trigger", async () => {
    await seed([{ id: "stale", kind: "derivedState", everyMs: 60_000, state: "stale" }])
    await writeBotTriggerState("boti_1", "stale", { lastEdgeValue: true }, NOW)

    await executeBotTask(task({ installationId: "boti_1", triggerId: "stale" }), execution, live)

    const [row] = await getDb().botEventDeliveries.toArray()
    // The host cannot evaluate the predicate, so it carries the last answer
    // and lets the handler tell a change from a state.
    expect(row.envelope.payload).toMatchObject({
      triggerKind: "derivedState",
      previousEdgeValue: true,
      state: "stale",
    })
  })

  it("refuses to fire a trigger the scheduler does not own", async () => {
    await seed([{ id: "opened", kind: "event", source: "integration", types: ["x"] }])

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "opened" }),
      execution,
      live
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("which the scheduler does not fire")
  })

  it("is terminal when the installation is gone", async () => {
    const result = await executeBotTask(
      task({ installationId: "boti_missing", triggerId: "x" }),
      execution,
      live
    )
    // Every future tick would fail the same way, so the scheduler is told to
    // stop rather than retry forever.
    expect(result.terminalReason).toBe("executor-failure")
  })

  it("fails without a terminal reason when the installation is merely disabled", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    await updateBotInstallation("boti_1", { status: "disabled" })

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      live
    )
    // Re-enabling it should start working again without touching the schedule.
    expect(result.success).toBe(false)
    expect(result.terminalReason).toBeUndefined()
  })

  it("does nothing once aborted", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const controller = new AbortController()
    controller.abort()

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      controller.signal
    )
    expect(result.success).toBe(false)
    expect(await getDb().botEventDeliveries.count()).toBe(0)
  })
})
