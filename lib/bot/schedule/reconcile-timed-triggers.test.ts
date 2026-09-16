/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { ScheduledTask } from "@/types/scheduler"

const tasks = new Map<string, ScheduledTask>()
let nextId = 0

const schedulerApi = {
  getAllTasks: jest.fn(async () => [...tasks.values()]),
  createTask: jest.fn(async (input: Record<string, unknown>) => {
    const id = `task_${(nextId += 1)}`
    tasks.set(id, { id, status: "active", ...input } as unknown as ScheduledTask)
    return tasks.get(id)!
  }),
  updateTask: jest.fn(async (id: string, patch: Record<string, unknown>) => {
    const existing = tasks.get(id)
    if (existing) tasks.set(id, { ...existing, ...patch } as ScheduledTask)
  }),
  deleteTask: jest.fn(async (id: string) => void tasks.delete(id)),
}

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerApi,
}))

const listBotInstallations = jest.fn(async () => [] as BotInstallationRow[])
const resolveInstalledBot = jest.fn(async () => undefined as InstalledBot | undefined)

jest.mock("@/lib/db/bot-installations", () => {
  const actual = jest.requireActual("@/lib/db/bot-installations")
  return {
    ...actual,
    listBotInstallations: (...args: unknown[]) => listBotInstallations(...(args as [])),
  }
})
jest.mock("@/lib/bot/installed-bot", () => ({
  resolveInstalledBot: (...args: unknown[]) => resolveInstalledBot(...(args as [])),
}))

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { readBotTriggerState, writeBotTriggerState } from "@/lib/db/bot-installations"

import {
  BOT_TRIGGER_TAG,
  botTriggerScheduleTag,
  reconcileAllBotSchedules,
  removeBotTriggerSchedules,
  schedulerTriggerFor,
  syncBotTriggerSchedules,
} from "./reconcile-timed-triggers"

const NOW = 1_700_000_000_000

function installation(overrides: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function resolved(
  triggers: PluginBotTriggerDef[],
  overrides: Partial<BotInstallationRow> = {}
): InstalledBot {
  return {
    installation: installation(overrides),
    definition: {
      id: "acme:digest",
      name: "Digest",
      version: "1.0.0",
      executor: "handler",
      source: "plugin",
      triggers,
    },
    policy: {},
  } as unknown as InstalledBot
}

beforeEach(() => {
  tasks.clear()
  nextId = 0
  for (const fn of Object.values(schedulerApi)) fn.mockClear()
  listBotInstallations.mockReset().mockResolvedValue([])
  resolveInstalledBot.mockReset().mockResolvedValue(undefined)
})

describe("schedulerTriggerFor", () => {
  it("maps a cron trigger, carrying its timezone", () => {
    expect(
      schedulerTriggerFor({ id: "daily", kind: "schedule", cron: "0 9 * * *", timezone: "UTC" })
    ).toEqual({ type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" })
  })

  it("maps poll and derivedState to the same interval shape", () => {
    // They differ in what the HANDLER does with the tick, which is not the
    // scheduler's business.
    expect(schedulerTriggerFor({ id: "p", kind: "poll", everyMs: 60_000 })).toEqual({
      type: "interval",
      intervalMs: 60_000,
    })
    expect(
      schedulerTriggerFor({ id: "d", kind: "derivedState", everyMs: 60_000, state: "stale" })
    ).toEqual({ type: "interval", intervalMs: 60_000 })
  })

  it("refuses the kinds that are fired by an event, not a clock", () => {
    expect(schedulerTriggerFor({ id: "m", kind: "manual" })).toBeNull()
    expect(schedulerTriggerFor({ id: "i", kind: "interaction" })).toBeNull()
    expect(
      schedulerTriggerFor({ id: "e", kind: "event", source: "integration", types: ["x"] })
    ).toBeNull()
  })
})

describe("syncBotTriggerSchedules", () => {
  it("keeps routine delivery ticks quiet and migrates existing noisy tasks", async () => {
    const bot = resolved([{ id: "poll", kind: "poll", everyMs: 60_000 }])
    await syncBotTriggerSchedules(bot)
    expect(tasks.get("task_1")?.notification).toEqual({
      onStart: false,
      onComplete: false,
      onError: true,
      channels: ["toast"],
    })
    const existing = tasks.get("task_1")!
    tasks.set("task_1", {
      ...existing,
      notification: { onStart: true, onComplete: true, onError: false, channels: ["none"] },
    })
    await syncBotTriggerSchedules(bot)
    expect(tasks.get("task_1")?.notification).toEqual({
      onStart: false,
      onComplete: false,
      onError: false,
      channels: ["none"],
    })
    schedulerApi.updateTask.mockClear()
    await syncBotTriggerSchedules(bot)
    expect(schedulerApi.updateTask).not.toHaveBeenCalled()
  })

  it("repairs legacy notification defaults without changing unrelated tasks", async () => {
    const bot = resolved([{ id: "poll", label: "Repository", kind: "poll", everyMs: 60_000 }])
    await syncBotTriggerSchedules(bot)
    const existing = tasks.get("task_1")!
    tasks.set("task_1", { ...existing, notification: undefined } as unknown as ScheduledTask)
    tasks.set("foreign", { ...existing, id: "foreign", type: "chat" })
    tasks.set("untagged", { ...existing, id: "untagged", tags: undefined })
    await syncBotTriggerSchedules(bot)
    expect(tasks.get("task_1")?.notification).toEqual({ onStart: false, onComplete: false })
    tasks.set("task_1", {
      ...existing,
      status: "paused",
      notification: { ...existing.notification, onStart: false, onComplete: true },
    })
    await syncBotTriggerSchedules(bot)
    expect(tasks.get("task_1")?.status).toBe("active")
    expect(tasks.get("task_1")?.notification.onComplete).toBe(false)
    await removeBotTriggerSchedules("boti_1")
    expect([...tasks.keys()]).toEqual(["foreign", "untagged"])
  })

  it("creates one task per armed timed trigger, in the executor's payload shape", async () => {
    await syncBotTriggerSchedules(
      resolved([
        { id: "daily", kind: "schedule", cron: "0 9 * * *" },
        { id: "manual", kind: "manual" },
      ])
    )

    expect(schedulerApi.createTask).toHaveBeenCalledTimes(1)
    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bot",
        trigger: { type: "cron", cronExpression: "0 9 * * *" },
        payload: { installationId: "boti_1", triggerId: "daily" },
        tags: [BOT_TRIGGER_TAG, botTriggerScheduleTag("boti_1", "daily")],
      })
    )
  })

  it("is idempotent, so an edit does not accumulate rows", async () => {
    const bot = resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }])
    await syncBotTriggerSchedules(bot)
    schedulerApi.createTask.mockClear()

    await syncBotTriggerSchedules(bot)

    expect(schedulerApi.createTask).not.toHaveBeenCalled()
    expect(tasks.size).toBe(1)
  })

  it("updates a task whose cadence drifted from the definition", async () => {
    await syncBotTriggerSchedules(resolved([{ id: "p", kind: "poll", everyMs: 60_000 }]))
    await syncBotTriggerSchedules(resolved([{ id: "p", kind: "poll", everyMs: 30_000 }]))

    expect(schedulerApi.updateTask).toHaveBeenCalledWith(
      "task_1",
      expect.objectContaining({ trigger: { type: "interval", intervalMs: 30_000 } })
    )
  })

  it("deletes the task when its trigger is disarmed", async () => {
    const triggers: PluginBotTriggerDef[] = [{ id: "daily", kind: "schedule", cron: "0 9 * * *" }]
    await syncBotTriggerSchedules(resolved(triggers))

    await syncBotTriggerSchedules(resolved(triggers, { triggerOverrides: { daily: false } }))

    expect(tasks.size).toBe(0)
  })

  it("drops every row while the installation is disabled, and keeps the row", async () => {
    const triggers: PluginBotTriggerDef[] = [{ id: "daily", kind: "schedule", cron: "0 9 * * *" }]
    await syncBotTriggerSchedules(resolved(triggers))

    await syncBotTriggerSchedules(resolved(triggers, { status: "disabled" }))

    expect(tasks.size).toBe(0)
  })

  it("attributes the task to the workspace the installation belongs to", async () => {
    await syncBotTriggerSchedules(
      resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }], {
        scope: { kind: "project", projectId: "proj_1" },
        projectId: "proj_1",
      })
    )

    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj_1" })
    )
  })

  it("leaves another installation's rows alone", async () => {
    await syncBotTriggerSchedules(resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }]))
    await syncBotTriggerSchedules(
      resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }], { id: "boti_2" })
    )

    await syncBotTriggerSchedules(resolved([], { id: "boti_2" }))

    expect([...tasks.values()].map((task) => task.payload)).toEqual([
      { installationId: "boti_1", triggerId: "daily" },
    ])
  })
})

describe("removeBotTriggerSchedules", () => {
  it("drops only the rows the named installation owned", async () => {
    await syncBotTriggerSchedules(resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }]))
    await syncBotTriggerSchedules(
      resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }], { id: "boti_2" })
    )

    await removeBotTriggerSchedules("boti_1")

    expect([...tasks.values()]).toHaveLength(1)
  })
})

describe("reconcileAllBotSchedules", () => {
  it("reaps a task whose installation was removed while this host was down", async () => {
    await syncBotTriggerSchedules(resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }]))
    listBotInstallations.mockResolvedValue([])

    await reconcileAllBotSchedules()

    expect(tasks.size).toBe(0)
  })

  it("keeps the rows of an installation that still resolves", async () => {
    const bot = resolved([{ id: "daily", kind: "schedule", cron: "0 9 * * *" }])
    await syncBotTriggerSchedules(bot)
    listBotInstallations.mockResolvedValue([bot.installation])
    resolveInstalledBot.mockResolvedValue(bot)

    await reconcileAllBotSchedules()

    expect(tasks.size).toBe(1)
  })

  it("skips an installation whose definition no longer resolves, without failing the sweep", async () => {
    listBotInstallations.mockResolvedValue([installation(), installation({ id: "boti_2" })])
    resolveInstalledBot.mockResolvedValue(undefined)

    await expect(reconcileAllBotSchedules()).resolves.toBeUndefined()
  })
})

describe("config-driven schedules", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botInstallations.clear()
  })

  async function seed(overrides: Partial<BotInstallationRow> = {}): Promise<InstalledBot> {
    const row = installation(overrides)
    await getDb().botInstallations.put(row)
    return {
      installation: row,
      definition: {
        id: "acme:digest",
        name: "Digest",
        version: "1.0.0",
        executor: "handler",
        source: "plugin",
        configSchema: {
          type: "object",
          properties: {
            schedule: { type: "string" },
            zone: { type: "string" },
            interval: { type: "number" },
          },
        },
        triggers: [],
      },
      policy: {},
    } as unknown as InstalledBot
  }

  function withTriggers(bot: InstalledBot, triggers: PluginBotTriggerDef[]): InstalledBot {
    return { ...bot, definition: { ...bot.definition, triggers } }
  }

  it("uses a valid configured cron and timezone instead of the definition's", async () => {
    const bot = await seed({ config: { schedule: "0 6 * * *", zone: "Asia/Tokyo" } })
    await syncBotTriggerSchedules(
      withTriggers(bot, [
        {
          id: "daily",
          kind: "schedule",
          cron: "0 9 * * *",
          timezone: "UTC",
          cronConfigKey: "schedule",
          timezoneConfigKey: "zone",
        },
      ])
    )

    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { type: "cron", cronExpression: "0 6 * * *", timezone: "Asia/Tokyo" },
      })
    )
    expect((await readBotTriggerState("boti_1", "daily"))?.configFallback).toBeUndefined()
  })

  it("falls back per key and records why", async () => {
    const bot = await seed({ config: { schedule: "not a cron", zone: "Mars/Olympus" } })
    await syncBotTriggerSchedules(
      withTriggers(bot, [
        {
          id: "daily",
          kind: "schedule",
          cron: "0 9 * * *",
          cronConfigKey: "schedule",
          timezoneConfigKey: "zone",
        },
      ])
    )

    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { type: "cron", cronExpression: "0 9 * * *" } })
    )
    expect((await readBotTriggerState("boti_1", "daily"))?.configFallback).toBe("invalid-cron")
  })

  it("reports a missing config value and an invalid timezone as their own codes", async () => {
    const bot = await seed({ config: { zone: "Not/AZone" } })
    await syncBotTriggerSchedules(
      withTriggers(bot, [
        {
          id: "daily",
          kind: "schedule",
          cron: "0 9 * * *",
          timezoneConfigKey: "zone",
        },
      ])
    )
    expect((await readBotTriggerState("boti_1", "daily"))?.configFallback).toBe("invalid-timezone")
  })

  it("uses a valid configured interval and rejects a sub-floor one", async () => {
    const bot = await seed({ config: { interval: 120_000 } })
    await syncBotTriggerSchedules(
      withTriggers(bot, [{ id: "p", kind: "poll", everyMs: 60_000, everyMsConfigKey: "interval" }])
    )
    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { type: "interval", intervalMs: 120_000 } })
    )

    tasks.clear()
    schedulerApi.createTask.mockClear()
    const floored = await seed({ config: { interval: 1_000 } })
    await syncBotTriggerSchedules(
      withTriggers(floored, [
        { id: "p", kind: "poll", everyMs: 60_000, everyMsConfigKey: "interval" },
      ])
    )
    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { type: "interval", intervalMs: 60_000 } })
    )
    expect((await readBotTriggerState("boti_1", "p"))?.configFallback).toBe("below-floor")
  })

  it("clamps a sub-floor definition everyMs even without a config key", async () => {
    const bot = await seed()
    await syncBotTriggerSchedules(withTriggers(bot, [{ id: "p", kind: "poll", everyMs: 500 }]))

    expect(schedulerApi.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { type: "interval", intervalMs: 15_000 } })
    )
  })

  it("clears the recorded fallback once the config value becomes valid", async () => {
    const bad = await seed({ config: { interval: 500 } })
    const trigger: PluginBotTriggerDef = {
      id: "p",
      kind: "poll",
      everyMs: 60_000,
      everyMsConfigKey: "interval",
    }
    await syncBotTriggerSchedules(withTriggers(bad, [trigger]))
    expect((await readBotTriggerState("boti_1", "p"))?.configFallback).toBe("below-floor")

    // The row keeps its recorded fallback; only the config value changes.
    const stored = (await getDb().botInstallations.get("boti_1"))!
    const good: InstalledBot = {
      ...bad,
      installation: { ...stored, config: { interval: 120_000 } },
    }
    await getDb().botInstallations.put(good.installation)
    await syncBotTriggerSchedules(withTriggers(good, [trigger]))
    const state = await readBotTriggerState("boti_1", "p")
    expect(state && "configFallback" in state).toBe(false)
  })

  it("leaves cursor and other state intact when recording a fallback", async () => {
    const bot = await seed({ config: { interval: 500 } })
    await writeBotTriggerState("boti_1", "p", { cursor: "page-2" })
    await syncBotTriggerSchedules(
      withTriggers(bot, [{ id: "p", kind: "poll", everyMs: 60_000, everyMsConfigKey: "interval" }])
    )
    expect((await readBotTriggerState("boti_1", "p"))?.cursor).toBe("page-2")
  })
})

describe("the mirror fence", () => {
  const CRON: PluginBotTriggerDef = { id: "nightly", kind: "schedule", cron: "0 9 * * *" }

  it("refuses to reconcile an installation this device mirrored from a Host", async () => {
    // Left unfenced, a desktop that mirrored another Host's installations and
    // then unpaired would sweep at boot and start firing that Host's crons
    // from its own scheduler, against rows the other machine is also firing.
    await syncBotTriggerSchedules(resolved([CRON], { syncedFromHost: true }))
    expect(schedulerApi.createTask).not.toHaveBeenCalled()
    expect(schedulerApi.getAllTasks).not.toHaveBeenCalled()
  })

  it("still reconciles an installation this device owns", async () => {
    await syncBotTriggerSchedules(resolved([CRON]))
    expect(schedulerApi.createTask).toHaveBeenCalledTimes(1)
  })

  it("fences the boot sweep too, through the same function", async () => {
    // One fence at the chokepoint rather than one per caller.
    listBotInstallations.mockResolvedValue([installation({ syncedFromHost: true })])
    resolveInstalledBot.mockResolvedValue(resolved([CRON], { syncedFromHost: true }))
    await reconcileAllBotSchedules()
    expect(schedulerApi.createTask).not.toHaveBeenCalled()
  })
})
