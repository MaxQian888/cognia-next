import type { NotificationRecord, NotificationPreferences } from "@/types/notifications"
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/types/notifications"

// `mock`-prefixed names are exempt from jest's factory hoisting guard.
const mockRows = new Map<string, NotificationRecord>()
let mockStoredPrefs: Partial<NotificationPreferences> | undefined
const mockPlatform = jest.fn<"tauri" | "mobile" | "web", []>(() => "tauri")
let mockPermissionGrantedHandler: (() => void) | null = null
const mockTransportCall = jest.fn()

jest.mock("sonner", () => ({
  toast: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@/lib/tauri/notification", () => ({
  checkNotificationPermission: jest.fn(),
  ensureNotificationPermission: jest.fn(),
  notify: jest.fn(),
}))
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => mockPlatform(),
  isTauri: () => false,
  isCapacitor: () => false,
  isHeadlessHost: () => false,
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))
jest.mock("@/lib/capacitor/local-notifications", () => ({
  checkPermission: jest.fn(),
  schedule: jest.fn(),
  subscribeNotificationPermissionGranted: jest.fn((handler: () => void) => {
    mockPermissionGrantedHandler = handler
    return jest.fn()
  }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: { notificationPreferences: mockStoredPrefs } }),
  },
}))
jest.mock("@/lib/db/notifications", () => ({
  findByDedupeKey: jest.fn(async (key: string, since: number) =>
    [...mockRows.values()].find(
      (r) => r.dedupeKey === key && r.updatedAt >= since && r.readState !== "done"
    )
  ),
  putNotification: jest.fn(async (r: NotificationRecord) => {
    mockRows.set(r.id, r)
  }),
  patchNotification: jest.fn(async (id: string, patch: Partial<NotificationRecord>) => {
    const cur = mockRows.get(id)
    if (cur) mockRows.set(id, { ...cur, ...patch })
  }),
  pruneNotifications: jest.fn(async () => 0),
}))

import { toast } from "sonner"
import * as tauriMod from "@/lib/tauri/notification"
import * as localNotifications from "@/lib/capacitor/local-notifications"
import { notify, refreshOsPermission } from "./runtime"
import { useNotificationStore } from "@/stores/notifications/notification-store"

const toastFns = toast as unknown as Record<"info" | "success" | "warning" | "error", jest.Mock>
const tauri = tauriMod as jest.Mocked<typeof tauriMod>
const local = localNotifications as jest.Mocked<typeof localNotifications>
const rows = mockRows

beforeEach(() => {
  jest.clearAllMocks()
  rows.clear()
  refreshOsPermission()
  mockPlatform.mockReturnValue("tauri")
  tauri.checkNotificationPermission.mockResolvedValue("granted")
  tauri.ensureNotificationPermission.mockResolvedValue("granted")
  local.checkPermission.mockResolvedValue({ kind: "ok", value: "granted" })
  local.schedule.mockResolvedValue({ kind: "ok", value: [1] })
  mockTransportCall.mockResolvedValue({ sent: 1 })
  mockStoredPrefs = { globalDefaultChannels: ["center", "toast", "os"] }
  useNotificationStore.setState({ items: [], directedUnread: 0, ambientUnseen: 0 })
})

it("persists, ingests into the store, and fires a toast", async () => {
  const id = await notify({ source: "system", level: "warning", title: "Hello", body: "World" })
  expect(rows.get(id)).toBeDefined()
  expect(toastFns.warning).toHaveBeenCalledWith(
    "Hello",
    expect.objectContaining({ description: "World" })
  )
  expect(useNotificationStore.getState().items.map((r) => r.id)).toEqual([id])
})

it("maps level to the matching sonner method", async () => {
  await notify({ source: "system", level: "success", title: "ok" })
  expect(toastFns.success).toHaveBeenCalled()
  await notify({ source: "system", level: "critical", title: "crit" })
  expect(toastFns.error).toHaveBeenCalled() // critical → error styling
})

it("fires the OS notification when permission is granted", async () => {
  await notify({ source: "system", level: "warning", title: "T", body: "B" })
  expect(tauri.notify).toHaveBeenCalledWith({ title: "T", body: "B" })
})

it("suppresses OS when permission is denied", async () => {
  tauri.checkNotificationPermission.mockResolvedValue("denied")
  refreshOsPermission()
  await notify({ source: "system", level: "warning", title: "T" })
  expect(tauri.notify).not.toHaveBeenCalled()
})

it("caches the permission check across notifications until refreshed", async () => {
  await notify({ source: "system", level: "warning", title: "1" })
  await notify({ source: "system", level: "warning", title: "2" })
  expect(tauri.checkNotificationPermission).toHaveBeenCalledTimes(1)
  refreshOsPermission()
  await notify({ source: "system", level: "warning", title: "3" })
  expect(tauri.checkNotificationPermission).toHaveBeenCalledTimes(2)
})

it("uses Capacitor local notifications for the OS channel on mobile", async () => {
  mockPlatform.mockReturnValue("mobile")
  refreshOsPermission()

  await notify({
    source: "system",
    level: "warning",
    title: "Mobile",
    body: "Native",
    href: "/inbox",
  })

  expect(local.checkPermission).toHaveBeenCalledTimes(1)
  expect(local.schedule).toHaveBeenCalledWith([
    expect.objectContaining({ title: "Mobile", body: "Native", extra: { route: "/inbox" } }),
  ])
  expect(tauri.notify).not.toHaveBeenCalled()
})

it("does not prompt or schedule a mobile OS notification without an existing grant", async () => {
  mockPlatform.mockReturnValue("mobile")
  local.checkPermission.mockResolvedValue({ kind: "ok", value: "prompt" })
  refreshOsPermission()

  await notify({ source: "system", level: "warning", title: "Mobile" })

  expect(local.checkPermission).toHaveBeenCalledTimes(1)
  expect(local.schedule).not.toHaveBeenCalled()
})

it("invalidates a cached mobile denial when another permission surface grants access", async () => {
  mockPlatform.mockReturnValue("mobile")
  local.checkPermission.mockResolvedValueOnce({ kind: "ok", value: "prompt" })
  refreshOsPermission()
  await notify({ source: "system", level: "warning", title: "Before grant" })
  expect(mockPermissionGrantedHandler).not.toBeNull()

  local.checkPermission.mockResolvedValueOnce({ kind: "ok", value: "granted" })
  mockPermissionGrantedHandler?.()
  await notify({ source: "system", level: "warning", title: "After grant" })

  expect(local.checkPermission).toHaveBeenCalledTimes(2)
  expect(local.schedule).toHaveBeenCalledTimes(1)
})

it("does not attempt an OS notification on the web", async () => {
  mockPlatform.mockReturnValue("web")
  refreshOsPermission()

  await notify({ source: "system", level: "warning", title: "Web" })

  expect(tauri.checkNotificationPermission).not.toHaveBeenCalled()
  expect(local.checkPermission).not.toHaveBeenCalled()
  expect(tauri.notify).not.toHaveBeenCalled()
  expect(local.schedule).not.toHaveBeenCalled()
})

it("uses the existing companion dispatcher for the push channel on desktop", async () => {
  mockStoredPrefs = { globalDefaultChannels: ["center", "push"] }

  const id = await notify({
    source: "scheduler",
    level: "warning",
    title: "Private task title",
    body: "Private task body",
    href: "/inbox",
  })

  expect(mockTransportCall).toHaveBeenCalledWith("companion_push_notification", {
    notificationId: id,
    source: "scheduler",
    level: "warning",
    href: "/inbox",
  })
  expect(JSON.stringify(mockTransportCall.mock.calls)).not.toContain("Private task")
  expect(rows.get(id)?.deliveredVia).toContain("push")
})

it("does not mark push delivered when no offline companion accepted it", async () => {
  mockStoredPrefs = { globalDefaultChannels: ["center", "push"] }
  mockTransportCall.mockResolvedValueOnce({ sent: 0 })

  const id = await notify({ source: "system", level: "warning", title: "T" })

  expect(rows.get(id)?.deliveredVia).not.toContain("push")
})

it("records a failed mobile native delivery without marking the OS channel delivered", async () => {
  mockPlatform.mockReturnValue("mobile")
  local.schedule.mockResolvedValue({ kind: "error", message: "native failure" })
  refreshOsPermission()

  const id = await notify({ source: "system", level: "warning", title: "Mobile" })

  expect(local.schedule).toHaveBeenCalledWith([
    expect.objectContaining({ body: "", extra: undefined }),
  ])
  expect(rows.get(id)?.deliveredVia).not.toContain("os")
})

it("wires the first action into the toast button", async () => {
  await notify({
    source: "system",
    level: "info",
    title: "T",
    actions: [{ id: "a", label: "Open", command: "open" }],
  })
  const opts = toastFns.info.mock.calls[0][1]
  expect(opts.action.label).toBe("Open")
  expect(typeof opts.action.onClick).toBe("function")
})

it("falls back to default preferences when none are stored", async () => {
  mockStoredPrefs = undefined
  await notify({ source: "system", level: "info", title: "T" })
  // default channels = center+toast → toast fires, os does not
  expect(toastFns.info).toHaveBeenCalled()
  expect(DEFAULT_NOTIFICATION_PREFERENCES.globalDefaultChannels).toEqual(["center", "toast"])
})
