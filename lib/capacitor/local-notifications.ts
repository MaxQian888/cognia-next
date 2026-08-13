"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/local-notifications` wrapper. Used by the offline backstop
 * (Wave 3) to alert the user when the outbound queue has stale entries
 * and by Backup to remind users when an automatic backup is due.
 */

/**
 * The app-wide Android notification channel. Created at boot
 * (`companion-boot-provider`) with IMPORTANCE_HIGH so reminders can
 * heads-up; [`schedule`] routes every notification here by default —
 * a spec without an explicit `channelId` would otherwise land on the
 * plugin's auto-created default-importance `"default"` channel.
 */
export const DEFAULT_CHANNEL_ID = "cognia-default"

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

export interface LocalNotificationAction {
  /** Plugin-reported action: "tap" for a plain body tap. */
  actionId: string
  notification: {
    id: number
    extra?: Record<string, unknown>
  }
}

interface LocalNotificationsShape {
  schedule(opts: { notifications: LocalNotificationSpec[] }): Promise<{
    notifications: Array<{ id: number }>
  }>
  addListener(
    event: "localNotificationActionPerformed",
    handler: (action: LocalNotificationAction) => void
  ): Promise<{ remove(): Promise<void> | void }>
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
export type Unsubscribe = () => void

export const NOTIFICATION_PERMISSION_GRANTED_EVENT = "cognia:notification-permission-granted"

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

/**
 * Check the current notification permission without prompting the user.
 * Used by [`NotificationPermissionCta`] on mount to decide whether the
 * "Enable" CTA should render. The flow there is intentionally
 * user-initiated — calling [`ensurePermission`] on mount would surface
 * the native permission dialog before the user has seen the rationale.
 */
export async function checkPermission(
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<PermissionState>> {
  return withPlugin(loader, async (n) => {
    const perm = await n.checkPermissions()
    return { kind: "ok" as const, value: normalizePerm(perm.display) }
  })
}

/**
 * Explicitly prompt the user. Wrapper around the underlying plugin call
 * — kept as a sibling of [`checkPermission`] so the CTA can dispatch
 * the prompt from a button click without recomputing the check.
 */
export async function requestPermission(
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<PermissionState>> {
  return withPlugin(loader, async (n) => {
    const perm = await n.requestPermissions()
    return { kind: "ok" as const, value: normalizePerm(perm.display) }
  })
}

function resolvePermissionEventTarget(target?: EventTarget): EventTarget | null {
  if (target) return target
  return typeof window === "undefined" ? null : window
}

/** Announce that the shared local/remote notification permission is granted. */
export function emitNotificationPermissionGranted(target?: EventTarget): boolean {
  return (
    resolvePermissionEventTarget(target)?.dispatchEvent(
      new Event(NOTIFICATION_PERMISSION_GRANTED_EVENT)
    ) ?? false
  )
}

/** Subscribe to contextual permission grants without coupling CTA call sites to push. */
export function subscribeNotificationPermissionGranted(
  handler: () => void,
  target?: EventTarget
): Unsubscribe {
  const resolved = resolvePermissionEventTarget(target)
  if (!resolved) return () => {}
  resolved.addEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, handler)
  return () => resolved.removeEventListener(NOTIFICATION_PERMISSION_GRANTED_EVENT, handler)
}

export async function schedule(
  notifications: LocalNotificationSpec[],
  loader: LocalNotificationsLoader = defaultLoader
): Promise<ValueOutcome<number[]>> {
  return withPlugin(loader, async (n) => {
    const result = await n.schedule({
      notifications: notifications.map((spec) => ({
        channelId: DEFAULT_CHANNEL_ID,
        ...spec,
      })),
    })
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

/**
 * Subscribe to notification taps (`localNotificationActionPerformed`).
 * A tapped reminder brings the app to the foreground; without this
 * listener the tap routes nowhere. The boot provider registers one
 * handler and navigates via the notification's `extra.route` payload.
 * Returns `null` when the plugin isn't available (web / desktop).
 */
export async function onAction(
  handler: (action: LocalNotificationAction) => void,
  loader: LocalNotificationsLoader = defaultLoader
): Promise<Unsubscribe | null> {
  try {
    const n = await loader()
    const listener = await n.addListener("localNotificationActionPerformed", handler)
    return () => {
      void listener.remove()
    }
  } catch {
    return null
  }
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
    // Channels are Android-only. The `!n.createChannel` property check is NOT
    // enough against the real Capacitor proxy (it fabricates a callable for
    // any name and then rejects "not implemented" on iOS), so gate on the
    // reported platform first; keep the property check for test doubles.
    const platform = (
      globalThis as { Capacitor?: { getPlatform?: () => string } }
    ).Capacitor?.getPlatform?.()
    if (platform === "ios") return { kind: "ok" as const }
    if (!n.createChannel) return { kind: "ok" as const }
    await n.createChannel({ id, name, description, importance, sound })
    return { kind: "ok" as const }
  })
}
