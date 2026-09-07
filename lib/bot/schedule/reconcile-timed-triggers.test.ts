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
