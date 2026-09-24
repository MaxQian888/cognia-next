/** @jest-environment jsdom */

import "fake-indexeddb/auto"

jest.setTimeout(30_000)

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { schedulerDb } from "./scheduler-db"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ScheduledTask } from "@/types/scheduler"
import {
  connectionTaskAdapterId,
  deleteConnectionTasksForAdapter,
  reapOrphanedConnectionTasks,
  ADAPTER_DISABLED_PRESENCE_TAG,
} from "./connection-task-orphans"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date()
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    name: "task",
    type: "connection:presence:refresh",
    trigger: { type: "interval", intervalMs: 60_000 },
    payload: {},
    config: { maxRetries: 3 } as ScheduledTask["config"],
    notification: {} as ScheduledTask["notification"],
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function seedTask(task: ScheduledTask): Promise<void> {
  await schedulerDb.createTask(task)
}

async function seedAdapter(id: string): Promise<AdapterInstanceRow> {
  return createAdapterInstance({
    id,
    type: "lark",
    displayName: "Bot",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { mode: "auto" } as unknown as AdapterInstanceRow["trigger"],
    defaultMode: "auto" as AdapterInstanceRow["defaultMode"],
  } as unknown as Parameters<typeof createAdapterInstance>[0])
}

function recordingPort() {
  const calls: string[] = []
  return {
    calls,
    pauseTask: jest.fn(async (_id: string) => true),
    updateTask: jest.fn(async (_id: string, _input: unknown) => true),
    deleteTask: jest.fn(async (id: string) => void calls.push(id)),
  }
}

describe("connectionTaskAdapterId", () => {
  it("extracts the bound adapter id and tolerates missing payloads", () => {
    expect(connectionTaskAdapterId(makeTask({ payload: { adapterId: "ad-1" } }))).toBe("ad-1")
    expect(connectionTaskAdapterId(makeTask({ payload: {} }))).toBeUndefined()
    expect(connectionTaskAdapterId(makeTask({ payload: undefined }))).toBeUndefined()
    expect(connectionTaskAdapterId(makeTask({ payload: { adapterId: 7 } }))).toBeUndefined()
  })
})

describe("deleteConnectionTasksForAdapter", () => {
  it("deletes every connection:* task bound to the adapter and nothing else", async () => {
    await seedTask(
      makeTask({
        id: "presence",
        payload: { adapterId: "ad-gone" },
        type: "connection:presence:refresh",
      })
    )
    await seedTask(
      makeTask({
        id: "outbound",
        payload: { adapterId: "ad-gone" },
        type: "connection:outbound:send",
      })
    )
    await seedTask(
      makeTask({
        id: "other-adapter",
        payload: { adapterId: "ad-kept" },
        type: "connection:presence:refresh",
      })
    )
    await seedTask(
      makeTask({ id: "non-connection", payload: { adapterId: "ad-gone" }, type: "chat" })
    )
    await seedTask(
      makeTask({ id: "global-housekeeping", payload: {}, type: "connection:housekeeping:clock" })
    )

    const port = recordingPort()
    const deleted = await deleteConnectionTasksForAdapter("ad-gone", port)

    expect(deleted.sort()).toEqual(["outbound", "presence"])
    expect(port.calls.sort()).toEqual(["outbound", "presence"])
  })

  it("returns empty when nothing binds the adapter", async () => {
    await seedTask(makeTask({ payload: { adapterId: "ad-kept" } }))
    const port = recordingPort()
    expect(await deleteConnectionTasksForAdapter("ad-gone", port)).toEqual([])
    expect(port.calls).toEqual([])
  })
})

describe("reapOrphanedConnectionTasks", () => {
  it("deletes only tasks whose adapter row is gone", async () => {
    await seedAdapter("ad-alive")
    await seedTask(
      makeTask({
        id: "orphan",
        payload: { adapterId: "ad-deleted" },
        type: "connection:presence:refresh",
      })
    )
    await seedTask(
      makeTask({
        id: "orphan-2",
        payload: { adapterId: "ad-deleted" },
        type: "connection:outbound:send",
      })
    )
    await seedTask(
      makeTask({
        id: "live",
        payload: { adapterId: "ad-alive" },
        type: "connection:presence:refresh",
      })
    )
    await seedTask(makeTask({ id: "unbound", payload: {}, type: "connection:housekeeping:clock" }))

    const port = recordingPort()
    const deleted = await reapOrphanedConnectionTasks(port)

    expect(deleted.sort()).toEqual(["orphan", "orphan-2"])
    expect(port.calls.sort()).toEqual(["orphan", "orphan-2"])
  })

  it("never deletes on a companion replica, where adapter rows arrive by sync", async () => {
    await seedTask(
      makeTask({
        id: "not-synced-yet",
        payload: { adapterId: "ad-pending" },
        type: "connection:presence:refresh",
      })
    )
    const port = recordingPort()
    const deleted = await reapOrphanedConnectionTasks(port, { adapterRowsAreLocal: () => false })
    expect(deleted).toEqual([])
    expect(port.calls).toEqual([])
    expect(await schedulerDb.getTask("not-synced-yet")).not.toBeNull()
  })

  it("is a no-op when every bound adapter exists", async () => {
    await seedAdapter("ad-alive")
    await seedTask(makeTask({ payload: { adapterId: "ad-alive" } }))
    const port = recordingPort()
    expect(await reapOrphanedConnectionTasks(port)).toEqual([])
    expect(port.calls).toEqual([])
  })

  it("deletes through the live scheduler so the row disappears from the store", async () => {
    await seedTask(
      makeTask({
        id: "orphan",
        payload: { adapterId: "ad-deleted" },
        type: "connection:presence:refresh",
      })
    )
    const { getTaskScheduler } = await import("./task-scheduler")
    const deleted = await reapOrphanedConnectionTasks(getTaskScheduler())
    expect(deleted).toEqual(["orphan"])
    expect(await schedulerDb.getTask("orphan")).toBeNull()
  })
})

it("pauses disabled adapters' presence schedules during boot instead of deleting them", async () => {
  await seedAdapter("disabled")
  await getDb().adapterInstances.update("disabled", { enabled: false })
  await seedTask(makeTask({ id: "disabled-presence", payload: { adapterId: "disabled" } }))
  const port = recordingPort()
  expect(await reapOrphanedConnectionTasks(port)).toEqual([])
  expect(port.pauseTask).toHaveBeenCalledWith("disabled-presence")
  expect(port.updateTask).toHaveBeenCalledWith("disabled-presence", {
    status: "paused",
    tags: [ADAPTER_DISABLED_PRESENCE_TAG],
  })
  expect(port.deleteTask).not.toHaveBeenCalled()
})

it("does not claim ownership of a user's existing pause during boot", async () => {
  await seedAdapter("disabled")
  await getDb().adapterInstances.update("disabled", { enabled: false })
  await seedTask(
    makeTask({ id: "manual-pause", status: "paused", payload: { adapterId: "disabled" } })
  )
  const port = recordingPort()
  await reapOrphanedConnectionTasks(port)
  expect(port.pauseTask).not.toHaveBeenCalled()
  expect(port.updateTask).not.toHaveBeenCalled()
})
