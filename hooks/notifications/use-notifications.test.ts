import { renderHook, waitFor, act } from "@testing-library/react"
import type { NotificationRecord } from "@/types/notifications"

jest.mock("@/lib/db/notifications", () => ({
  listNotifications: jest.fn(),
  getNotification: jest.fn(),
  patchNotification: jest.fn().mockResolvedValue(undefined),
  deleteNotification: jest.fn().mockResolvedValue(undefined),
  clearNotifications: jest.fn().mockResolvedValue(undefined),
}))

import * as dbModule from "@/lib/db/notifications"
import { useNotifications } from "./use-notifications"
import { useNotificationStore } from "@/stores/notifications/notification-store"

const db = dbModule as jest.Mocked<typeof dbModule>

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: over.id ?? "n1",
    source: over.source ?? "system",
    level: "info",
    title: "T",
    createdAt: 1,
    updatedAt: 1,
    readState: over.readState ?? "unseen",
    count: 1,
    directed: over.directed ?? false,
    deliveredVia: ["center"],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  db.listNotifications.mockResolvedValue([])
  useNotificationStore.setState({
    items: [],
    directedUnread: 0,
    ambientUnseen: 0,
    hydrated: false,
    sourceFilter: undefined,
  })
})

it("hydrates from Dexie on mount and exposes items + counts", async () => {
  db.listNotifications.mockResolvedValueOnce([rec({ id: "a", directed: true })])
  const { result } = renderHook(() => useNotifications())
  await waitFor(() => expect(result.current.hydrated).toBe(true))
  expect(result.current.items.map((r) => r.id)).toEqual(["a"])
  expect(result.current.directedUnread).toBe(1)
  expect(result.current.hasUnread).toBe(true)
})

it("does not re-hydrate when already hydrated", async () => {
  useNotificationStore.setState({ hydrated: true })
  renderHook(() => useNotifications())
  await waitFor(() => expect(db.listNotifications).not.toHaveBeenCalled())
})

it("exposes bulk actions including archiveAll", () => {
  useNotificationStore.setState({ hydrated: true })
  const { result } = renderHook(() => useNotifications())
  expect(result.current.archiveAll).toBe(useNotificationStore.getState().archiveAll)
})

it("applies the source filter to visible items", async () => {
  useNotificationStore.setState({
    items: [rec({ id: "a", source: "connector" }), rec({ id: "b", source: "scheduler" })],
    hydrated: true,
  })
  const { result } = renderHook(() => useNotifications())
  act(() => result.current.setSourceFilter("connector"))
  await waitFor(() => expect(result.current.items.map((r) => r.id)).toEqual(["a"]))
  expect(result.current.allItems).toHaveLength(2)
})
