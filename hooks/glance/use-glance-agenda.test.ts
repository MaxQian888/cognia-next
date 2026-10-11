import { renderHook } from "@testing-library/react"

import type { NotificationRecord } from "@/types/notifications"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/components/desktop/status-bar-sync", () => ({
  activePairedDevices: jest.fn((rows: Array<Record<string, unknown>>) =>
    rows.filter(
      (r) => r.revokedAt === undefined && r.pausedAt === undefined && r.platform !== "browser"
    )
  ),
  canHearInvalidations: jest.fn((state: string) => state === "ready" || state === "replaying"),
}))
jest.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: jest.fn() }))
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: jest.fn(),
}))
jest.mock("@/lib/companion/device-presence-registry", () => ({ eventPlaneState: jest.fn() }))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: jest.fn() }))
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getUpcomingTasks: jest.fn(), getRecentExecutions: jest.fn() },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: jest.fn(() => false),
  subscribeActiveRemoteTransport: jest.fn(() => () => {}),
}))
jest.mock("@/stores/notifications/notification-store", () => {
  const state = { items: [] as unknown[], hydrated: true, hydrate: jest.fn() }
  const useNotificationStore = Object.assign(
    jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: () => state }
  )
  return { useNotificationStore }
})

import { useLiveQuery } from "dexie-react-hooks"

import { useNetworkStatus } from "@/hooks/use-network-status"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { eventPlaneState } from "@/lib/companion/device-presence-registry"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { useNotificationStore } from "@/stores/notifications/notification-store"

import { useGlanceAgenda } from "./use-glance-agenda"

const useLiveQueryMock = useLiveQuery as unknown as jest.Mock
const networkMock = useNetworkStatus as jest.Mock
const hostTargetMock = useSchedulerHostTarget as jest.Mock
const planeMock = eventPlaneState as jest.Mock
const listDevicesMock = listPairedDevices as jest.Mock
const upcomingMock = schedulerDb.getUpcomingTasks as jest.Mock
const recentMock = schedulerDb.getRecentExecutions as jest.Mock
const remoteMock = isRemoteHostActive as jest.Mock

type NotificationState = { items: unknown[]; hydrated: boolean; hydrate: jest.Mock }
const notificationState = (
  useNotificationStore as unknown as { getState: () => NotificationState }
).getState()

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime()
const MINUTE = 60_000

function device(
  partial: Partial<PairedDeviceRow> & Pick<PairedDeviceRow, "deviceId">
): PairedDeviceRow {
  return { label: "Phone", platform: "ios", lastSeenAt: 0, ...partial } as PairedDeviceRow
}

function notification(
  partial: Partial<NotificationRecord> & Pick<NotificationRecord, "id">
): NotificationRecord {
  return {
    source: "system",
    title: "Hello",
    createdAt: NOW - 1_000,
    readState: "unseen",
    ...partial,
  } as NotificationRecord
}

describe("useGlanceAgenda", () => {
  // The three useLiveQuery calls in render order: next task, recent executions, devices.
  let nextTaskValue: unknown
  let executionsValue: unknown
  let devicesValue: unknown
  let callIndex: number

  beforeEach(() => {
    jest.clearAllMocks()
    nextTaskValue = null
    executionsValue = []
    devicesValue = []
    callIndex = 0
    useLiveQueryMock.mockImplementation(() => {
      const i = callIndex++ % 3
      return [nextTaskValue, executionsValue, devicesValue][i]
    })
    networkMock.mockReturnValue({
      loading: false,
      status: { connected: true, connectionType: "wifi" },
    })
    hostTargetMock.mockReturnValue({
      target: "local",
      pairedAvailable: false,
      setTarget: jest.fn(),
    })
    planeMock.mockReturnValue("disconnected")
    remoteMock.mockReturnValue(false)
    upcomingMock.mockResolvedValue([])
    recentMock.mockResolvedValue([])
    listDevicesMock.mockResolvedValue([])
    notificationState.items = []
    notificationState.hydrated = true
    notificationState.hydrate.mockReset()
    notificationState.hydrate.mockResolvedValue(undefined)
  })

  function render(enabled: boolean, now: number = NOW) {
    return renderHook(({ on, at }: { on: boolean; at: number }) => useGlanceAgenda(on, at), {
      initialProps: { on: enabled, at: now },
    })
  }

  /** The queriers and deps of the most recent render's three live queries. */
  function lastQueries() {
    const calls = useLiveQueryMock.mock.calls.slice(-3)
    return {
      nextTask: {
        run: calls[0][0] as () => Promise<unknown>,
        deps: calls[0][1] as unknown[],
        initial: calls[0][2],
      },
      executions: {
        run: calls[1][0] as () => Promise<unknown>,
        deps: calls[1][1] as unknown[],
        initial: calls[1][2],
      },
      devices: {
        run: calls[2][0] as () => Promise<unknown>,
        deps: calls[2][1] as unknown[],
        initial: calls[2][2],
      },
    }
  }

  describe("disabled", () => {
    it("returns null", () => {
      const { result } = render(false)
      expect(result.current).toBeNull()
    })

    it("does not hydrate the notification store", () => {
      notificationState.hydrated = false
      render(false)
      expect(notificationState.hydrate).not.toHaveBeenCalled()
    })

    it("reads nothing from the scheduler or the device table", async () => {
      render(false)
      const q = lastQueries()
      await expect(q.nextTask.run()).resolves.toBeNull()
      await expect(q.executions.run()).resolves.toEqual([])
      await expect(q.devices.run()).resolves.toEqual([])
      expect(upcomingMock).not.toHaveBeenCalled()
      expect(recentMock).not.toHaveBeenCalled()
      expect(listDevicesMock).not.toHaveBeenCalled()
    })

    it("stays null regardless of what the sources hold", () => {
      nextTaskValue = { id: "t", type: "x", name: "n", nextRunAt: NOW + MINUTE }
      notificationState.items = [notification({ id: "n1" })]
      const { result } = render(false)
      expect(result.current).toBeNull()
    })
  })

  describe("enabled slice", () => {
    it("builds an empty slice from empty sources", () => {
      const { result } = render(true)
      expect(result.current).toEqual({
        updatedAt: NOW,
        schedulerLocal: true,
        nextRun: null,
        lastOutcome: null,
        unread: 0,
        latestUnreadTitle: null,
        connectivity: { state: "unpaired", connected: 0, total: 0, lastContactAt: null },
      })
    })

    it("carries the next scheduled run under its unified id", () => {
      nextTaskValue = { id: "t1", type: "cron", name: "Morning brief", nextRunAt: NOW + 5 * MINUTE }
      const { result } = render(true)
      expect(result.current?.nextRun).toEqual({
        itemId: "app:t1",
        name: "Morning brief",
        at: NOW + 5 * MINUTE,
      })
    })

    it("lists plugin and connector tasks under their own unified kind", () => {
      nextTaskValue = { id: "p1", type: "plugin", name: "P", nextRunAt: NOW }
      expect(render(true).result.current?.nextRun?.itemId).toBe("plugin:p1")
      nextTaskValue = { id: "c1", type: "connection:slack", name: "C", nextRunAt: NOW }
      expect(render(true).result.current?.nextRun?.itemId).toBe("connector:c1")
    })

    it("reports the newest terminal execution as the last outcome", () => {
      executionsValue = [
        { taskName: "Running now", status: "running", startedAt: NOW - 10, completedAt: null },
        { taskName: "Nightly", status: "failed", startedAt: NOW - 1_000, completedAt: NOW - 500 },
        {
          taskName: "Older",
          status: "completed",
          startedAt: NOW - 9_000,
          completedAt: NOW - 8_000,
        },
      ]
      const { result } = render(true)
      expect(result.current?.lastOutcome).toEqual({ ok: false, at: NOW - 500, name: "Nightly" })
    })

    it("counts unread notifications and names the latest", () => {
      notificationState.items = [
        notification({ id: "a", title: "Older", createdAt: NOW - 5_000 }),
        notification({ id: "b", title: "Newest", createdAt: NOW - 100 }),
        notification({ id: "c", title: "Done", readState: "done" }),
        notification({ id: "d", title: "Snoozed", snoozedUntil: NOW + MINUTE }),
        notification({ id: "e", title: "Seen ambient", readState: "seen" }),
      ]
      const { result } = render(true)
      expect(result.current?.unread).toBe(2)
      expect(result.current?.latestUnreadTitle).toBe("Newest")
    })

    it("counts a seen but directed notification as unread", () => {
      notificationState.items = [notification({ id: "a", readState: "seen", directed: true })]
      expect(render(true).result.current?.unread).toBe(1)
    })

    it("does not offer a scheduler agenda when tasks run on another host", () => {
      hostTargetMock.mockReturnValue({
        target: "paired",
        pairedAvailable: true,
        setTarget: jest.fn(),
      })
      nextTaskValue = { id: "t1", type: "cron", name: "Morning brief", nextRunAt: NOW }
      executionsValue = [{ taskName: "x", status: "completed", startedAt: NOW, completedAt: NOW }]
      const { result } = render(true)
      expect(result.current?.schedulerLocal).toBe(false)
      expect(result.current?.nextRun).toBeNull()
      expect(result.current?.lastOutcome).toBeNull()
    })

    it("returns the same slice object while its inputs are unchanged", () => {
      const { result, rerender } = render(true)
      const first = result.current
      rerender({ on: true, at: NOW })
      expect(result.current).toBe(first)
    })
  })

  describe("connectivity", () => {
    it("is offline whenever the network is down, ahead of remote and paired", () => {
      networkMock.mockReturnValue({
        loading: false,
        status: { connected: false, connectionType: "none" },
      })
      remoteMock.mockReturnValue(true)
      devicesValue = [device({ deviceId: "d1" })]
      expect(render(true).result.current?.connectivity.state).toBe("offline")
    })

    it("is remote while a remote host is active", () => {
      remoteMock.mockReturnValue(true)
      devicesValue = [device({ deviceId: "d1" })]
      expect(render(true).result.current?.connectivity.state).toBe("remote")
    })

    it("is unpaired with no devices", () => {
      expect(render(true).result.current?.connectivity.state).toBe("unpaired")
    })

    it("is paired with devices, counting the ones that can hear invalidations", () => {
      devicesValue = [
        device({ deviceId: "d1", lastSeenAt: 100 }),
        device({ deviceId: "d2", lastSeenAt: 900 }),
        device({ deviceId: "d3", lastSeenAt: 500 }),
      ]
      planeMock.mockImplementation((id: string) =>
        id === "d1" ? "ready" : id === "d2" ? "replaying" : "disconnected"
      )
      const { result } = render(true)
      expect(result.current?.connectivity).toEqual({
        state: "paired",
        connected: 2,
        total: 3,
        lastContactAt: 900,
      })
      expect(planeMock).toHaveBeenCalledWith("d1", NOW)
    })

    it("has no last contact without devices", () => {
      expect(render(true).result.current?.connectivity.lastContactAt).toBeNull()
    })
  })

  describe("queries", () => {
    it("keys the scheduler reads by minute and the device read by enabled", () => {
      render(true)
      const q = lastQueries()
      expect(q.nextTask.deps).toEqual([true, true, Math.floor(NOW / MINUTE)])
      expect(q.executions.deps).toEqual([true, true])
      expect(q.devices.deps).toEqual([true])
    })

    it("re-keys the next-task read when the minute rolls over, not within it", () => {
      const { rerender } = render(true, NOW)
      const before = lastQueries().nextTask.deps
      rerender({ on: true, at: NOW + 1_000 })
      expect(lastQueries().nextTask.deps).toEqual(before)
      rerender({ on: true, at: NOW + MINUTE })
      expect(lastQueries().nextTask.deps[2]).toBe((before[2] as number) + 1)
    })

    it("reflects a non-local scheduler host in the deps", () => {
      hostTargetMock.mockReturnValue({
        target: "paired",
        pairedAvailable: true,
        setTarget: jest.fn(),
      })
      render(true)
      expect(lastQueries().nextTask.deps[1]).toBe(false)
      expect(lastQueries().executions.deps[1]).toBe(false)
    })

    it("seeds the live queries with null, an empty list and an empty list", () => {
      render(true)
      const q = lastQueries()
      expect(q.nextTask.initial).toBeNull()
      expect(q.executions.initial).toEqual([])
      expect(q.devices.initial).toEqual([])
    })

    it("reads the single upcoming task and normalizes Date and string run times", async () => {
      render(true)
      upcomingMock.mockResolvedValue([
        { id: "t1", type: "cron", name: "Brief", nextRunAt: new Date(NOW + MINUTE) },
      ])
      await expect(lastQueries().nextTask.run()).resolves.toEqual({
        id: "t1",
        type: "cron",
        name: "Brief",
        nextRunAt: NOW + MINUTE,
      })
      expect(upcomingMock).toHaveBeenCalledWith(1)

      upcomingMock.mockResolvedValue([
        {
          id: "t2",
          type: "cron",
          name: "Brief",
          nextRunAt: new Date(NOW + 2 * MINUTE).toISOString(),
        },
      ])
      await expect(lastQueries().nextTask.run()).resolves.toMatchObject({
        nextRunAt: NOW + 2 * MINUTE,
      })
    })

    it.each([
      ["no upcoming task", [] as unknown[]],
      ["a task without a run time", [{ id: "t", type: "cron", name: "n" }]],
      ["an unparseable run time", [{ id: "t", type: "cron", name: "n", nextRunAt: "not a date" }]],
    ])("resolves no next task for %s", async (_name, tasks) => {
      render(true)
      upcomingMock.mockResolvedValue(tasks)
      await expect(lastQueries().nextTask.run()).resolves.toBeNull()
    })

    it("skips the scheduler reads when the scheduler is not local", async () => {
      hostTargetMock.mockReturnValue({
        target: "paired",
        pairedAvailable: true,
        setTarget: jest.fn(),
      })
      render(true)
      const q = lastQueries()
      await expect(q.nextTask.run()).resolves.toBeNull()
      await expect(q.executions.run()).resolves.toEqual([])
      expect(upcomingMock).not.toHaveBeenCalled()
      expect(recentMock).not.toHaveBeenCalled()
    })

    it("maps the five most recent executions to millisecond timestamps", async () => {
      render(true)
      recentMock.mockResolvedValue([
        {
          taskName: "A",
          status: "completed",
          startedAt: new Date(NOW - 2_000),
          completedAt: new Date(NOW - 1_000),
        },
        { taskName: "B", status: "running", startedAt: NOW - 500, completedAt: undefined },
        { taskName: "C", status: "failed", startedAt: "garbage", completedAt: null },
      ])
      await expect(lastQueries().executions.run()).resolves.toEqual([
        { taskName: "A", status: "completed", startedAt: NOW - 2_000, completedAt: NOW - 1_000 },
        { taskName: "B", status: "running", startedAt: NOW - 500, completedAt: null },
        { taskName: "C", status: "failed", startedAt: 0, completedAt: null },
      ])
      expect(recentMock).toHaveBeenCalledWith(5)
    })

    it("lists paired devices through the active-device filter", async () => {
      render(true)
      listDevicesMock.mockResolvedValue([
        device({ deviceId: "ok" }),
        device({ deviceId: "revoked", revokedAt: 1 }),
        device({ deviceId: "paused", pausedAt: 1 }),
        device({ deviceId: "ext", platform: "browser" }),
      ])
      const out = (await lastQueries().devices.run()) as PairedDeviceRow[]
      expect(out.map((d) => d.deviceId)).toEqual(["ok"])
    })
  })

  describe("notification hydration", () => {
    it("hydrates when enabled and the store is not hydrated", () => {
      notificationState.hydrated = false
      render(true)
      expect(notificationState.hydrate).toHaveBeenCalledTimes(1)
    })

    it("does not hydrate an already hydrated store", () => {
      notificationState.hydrated = true
      render(true)
      expect(notificationState.hydrate).not.toHaveBeenCalled()
    })

    it("hydrates once the module is enabled", () => {
      notificationState.hydrated = false
      const { rerender } = render(false)
      expect(notificationState.hydrate).not.toHaveBeenCalled()
      rerender({ on: true, at: NOW })
      expect(notificationState.hydrate).toHaveBeenCalledTimes(1)
    })

    it("does not re-hydrate on later ticks", () => {
      notificationState.hydrated = false
      const { rerender } = render(true)
      rerender({ on: true, at: NOW + MINUTE })
      expect(notificationState.hydrate).toHaveBeenCalledTimes(1)
    })
  })
})
