"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/local-notifications` wrapper. Used by the offline backstop
 * (Wave 3) to alert the user when the outbound queue has stale entries
 * and by Backup to remind users when an automatic backup is due.
 */

export interface LocalNotificationSpec {
  id: number
  title: string
  body: string
  schedule?: { at?: Date; every?: "day" | "hour" | "minute"; count?: number }
  sound?: string
  smallIcon?: string
  iconColor?: string
  channelId?: string
  extra?: Record<string, unknown>
}

interface LocalNotificationsShape {
  schedule(opts: { notifications: LocalNotificationSpec[] }): Promise<{
    notifications: Array<{ id: number }>
  }>
  cancel(opts: { notifications: Array<{ id: number }> }): Promise<void>
  getPending(): Promise<{ notifications: LocalNotificationSpec[] }>
  requestPermissions(): Promise<{
    display: "granted" | "denied" | "prompt" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    display: "granted" | "denied" | "prompt" | "prompt-with-rationale"
  }>
  createChannel?(opts: {
    id: string
    name: string
    description?: string
    importance: 1 | 2 | 3 | 4 | 5
    sound?: string
    visibility?: -1 | 0 | 1
  }): Promise<void>
}

export type LocalNotificationsLoader = () => Promise<LocalNotificationsShape>

const defaultLoader: LocalNotificationsLoader = makeDefaultLoader<LocalNotificationsShape>(
  "@capacitor/local-notifications",
  "LocalNotifications"
)

export type PermissionState = "granted" | "denied" | "prompt"

function normalizePerm(state: string): PermissionState {
  return state === "granted" ? "granted" : state === "denied" ? "denied" : "prompt"
}

export async function ensurePermission(
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<PermissionState>> {
  return withPlugin(loader, async (n) => {
    let perm = await n.checkPermissions()
    if (perm.display !== "granted") {
      perm = await n.requestPermissions()
    }
    return { kind: "ok" as const, value: normalizePerm(perm.display) }
  })
}

export async function schedule(
  notifications: LocalNotificationSpec[],
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<number[]>> {
  return withPlugin(loader, async (n) => {
    const result = await n.schedule({ notifications })
    return {
      kind: "ok" as const,
      value: result.notifications.map((x) => x.id),
    }
  })
}

export async function cancel(
  ids: number[],
  loader: LocalNotificationsLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (n) => {
    await n.cancel({ notifications: ids.map((id) => ({ id })) })
    return { kind: "ok" as const }
  })
}

export async function listPending(
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<LocalNotificationSpec[]>> {
  return withPlugin(loader, async (n) => {
    const result = await n.getPending()
    return { kind: "ok" as const, value: result.notifications }
  })
}

export async function ensureChannel(
  opts: {
    id: string
    name: string
    description?: string
    importance?: 1 | 2 | 3 | 4 | 5
    sound?: string
  },
  loader: LocalNotificationsLoader = defaultLoader
): Promise<SimpleOutcome> {
  const { id, name, description, importance = 4, sound } = opts
  return withPlugin(loader, async (n) => {
    if (!n.createChannel) return { kind: "ok" as const } // iOS — no-op
    await n.createChannel({ id, name, description, importance, sound })
    return { kind: "ok" as const }
  })
}
