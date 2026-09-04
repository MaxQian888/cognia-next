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

  it("gives every tick its own event, so a second tick is not deduplicated away", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const payload = task({ installationId: "boti_1", triggerId: "morning" })

    await executeBotTask(payload, execution, live)
    await executeBotTask(payload, execution, live)

    // A deterministic event id would collapse the second tick onto the first
    // delivery and the Bot would run once, ever.
    expect(await getDb().botEventDeliveries.count()).toBe(2)
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
