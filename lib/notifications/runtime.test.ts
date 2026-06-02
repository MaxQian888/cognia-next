import type { NotificationRecord, NotificationPreferences } from "@/types/notifications"
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/types/notifications"

// `mock`-prefixed names are exempt from jest's factory hoisting guard.
const mockRows = new Map<string, NotificationRecord>()
let mockStoredPrefs: Partial<NotificationPreferences> | undefined

jest.mock("sonner", () => ({
  toast: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@/lib/tauri/notification", () => ({
  ensureNotificationPermission: jest.fn(),
  notify: jest.fn(),
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
import { notify, refreshOsPermission } from "./runtime"
import { useNotificationStore } from "@/stores/notifications/notification-store"

const toastFns = toast as unknown as Record<"info" | "success" | "warning" | "error", jest.Mock>
const tauri = tauriMod as jest.Mocked<typeof tauriMod>
const rows = mockRows

beforeEach(() => {
  jest.clearAllMocks()
  rows.clear()
  refreshOsPermission()
  tauri.ensureNotificationPermission.mockResolvedValue("granted")
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
  tauri.ensureNotificationPermission.mockResolvedValue("denied")
  refreshOsPermission()
  await notify({ source: "system", level: "warning", title: "T" })
  expect(tauri.notify).not.toHaveBeenCalled()
})

it("caches the permission check across notifications until refreshed", async () => {
  await notify({ source: "system", level: "warning", title: "1" })
  await notify({ source: "system", level: "warning", title: "2" })
  expect(tauri.ensureNotificationPermission).toHaveBeenCalledTimes(1)
  refreshOsPermission()
  await notify({ source: "system", level: "warning", title: "3" })
  expect(tauri.ensureNotificationPermission).toHaveBeenCalledTimes(2)
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
