"use client"

/**
 * Main-window feed for the glance agenda slice: next scheduled run and last
 * outcome, unread notifications, connectivity (ADR-0225 §2).
 *
 * Each part reads the same source its status-bar segment reads, so the panel
 * line and the status bar never disagree: `schedulerDb.getUpcomingTasks`
 * behind the host-target gate (`status-bar-next-run.tsx`), the notification
 * store (`notification-bell.tsx`), and the paired-device event plane
 * (`status-bar-sync.tsx`). Inert while `enabled` is false.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { activePairedDevices, canHearInvalidations } from "@/components/desktop/status-bar-sync"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { eventPlaneState } from "@/lib/companion/device-presence-registry"
import { listPairedDevices } from "@/lib/db/paired-devices"
import {
  buildAgendaSlice,
  type AgendaExecutionInput,
  type AgendaTaskInput,
} from "@/lib/glance/build-agenda"
import type { GlanceAgendaSlice } from "@/lib/glance/snapshot"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { useNotificationStore } from "@/stores/notifications/notification-store"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

const EMPTY_DEVICES: PairedDeviceRow[] = []

function subscribeRemote(onChange: () => void): () => void {
  return subscribeActiveRemoteTransport(() => onChange())
}

const toMs = (value: Date | number | string | undefined | null): number | null => {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function useGlanceAgenda(enabled: boolean, now: number): GlanceAgendaSlice | null {
  const { target } = useSchedulerHostTarget()
  const schedulerLocal = target === "local"
  // Re-key the scheduler reads once a minute, the cadence the next-run label
  // can change at, rather than on every snapshot tick.
  const minute = Math.floor(now / 60_000)

  const nextTask = useLiveQuery<AgendaTaskInput | null, null>(
    async () => {
      if (!enabled || !schedulerLocal) return null
      const [task] = await schedulerDb.getUpcomingTasks(1)
      const at = toMs(task?.nextRunAt)
      return task && at != null
        ? { id: task.id, type: task.type, name: task.name, nextRunAt: at }
        : null
    },
    [enabled, schedulerLocal, minute],
    null
  )

  const recentExecutions = useLiveQuery<AgendaExecutionInput[], AgendaExecutionInput[]>(
    async () => {
      if (!enabled || !schedulerLocal) return []
      const executions = await schedulerDb.getRecentExecutions(5)
      return executions.map((e) => ({
        taskName: e.taskName,
        status: e.status,
        startedAt: toMs(e.startedAt) ?? 0,
        completedAt: toMs(e.completedAt),
      }))
    },
    [enabled, schedulerLocal],
    []
  )

  const notifications = useNotificationStore((s) => s.items)
  const notificationsHydrated = useNotificationStore((s) => s.hydrated)
  const hydrateNotifications = useNotificationStore((s) => s.hydrate)
  useEffect(() => {
    if (enabled && !notificationsHydrated) void hydrateNotifications()
  }, [enabled, notificationsHydrated, hydrateNotifications])

  const remote = useSyncExternalStore(subscribeRemote, isRemoteHostActive, () => false)
  const devices = useLiveQuery<PairedDeviceRow[], PairedDeviceRow[]>(
    async () => (enabled ? activePairedDevices(await listPairedDevices()) : EMPTY_DEVICES),
    [enabled],
    EMPTY_DEVICES
  )
  const { status: network } = useNetworkStatus()

  return useMemo(() => {
    if (!enabled) return null
    const connected = devices.filter((device) =>
      canHearInvalidations(eventPlaneState(device.deviceId, now))
    ).length
    const lastContactAt = devices.reduce<number | null>(
      (acc, device) => (acc === null ? device.lastSeenAt : Math.max(acc, device.lastSeenAt)),
      null
    )
    const state: GlanceAgendaSlice["connectivity"]["state"] = !network.connected
      ? "offline"
      : remote
        ? "remote"
        : devices.length === 0
          ? "unpaired"
          : "paired"
    return buildAgendaSlice({
      schedulerLocal,
      nextTask,
      recentExecutions,
      notifications,
      connectivity: { state, connected, total: devices.length, lastContactAt },
      now,
    })
  }, [
    enabled,
    devices,
    now,
    network.connected,
    remote,
    schedulerLocal,
    nextTask,
    recentExecutions,
    notifications,
  ])
}
