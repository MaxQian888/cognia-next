import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationRecord } from "@/types/notifications"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
  useFormatter: () => ({ relativeTime: () => "now" }),
  useNow: () => new Date("2024-01-01T00:00:00Z"),
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const dispatchCmd = jest.fn()
jest.mock("@/lib/notifications/action-registry", () => ({
  dispatchNotificationCommand: (...a: unknown[]) => dispatchCmd(...a),
}))

const listDone = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/notifications", () => ({
  listNotifications: (...a: unknown[]) => listDone(...a),
}))

const hook = {
  items: [] as NotificationRecord[],
  markSeen: jest.fn(),
  markRead: jest.fn(),
  markDone: jest.fn(),
  restore: jest.fn().mockResolvedValue(undefined),
  markAllRead: jest.fn(),
  archiveAll: jest.fn().mockResolvedValue(undefined),
  snooze: jest.fn(),
  remove: jest.fn().mockResolvedValue(undefined),
  clearAll: jest.fn().mockResolvedValue(undefined),
  sourceFilter: undefined as string | undefined,
  setSourceFilter: jest.fn(),
  refresh: jest.fn().mockResolvedValue(undefined),
}
jest.mock("@/hooks/notifications/use-notifications", () => ({ useNotifications: () => hook }))

import { NotificationCenter } from "./notification-center"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    source: "connector",
    level: "info",
    title: "Hello",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  hook.items = []
  hook.sourceFilter = undefined
})

it("shows the empty state when there are no notifications", () => {
  render(<NotificationCenter />)
  expect(screen.getByTestId("notification-empty")).toBeInTheDocument()
})

it("renders notifications from the store", () => {
  hook.items = [rec({ id: "a", title: "Alpha" }), rec({ id: "b", title: "Beta" })]
  render(<NotificationCenter />)
  expect(screen.getByText("Alpha")).toBeInTheDocument()
  expect(screen.getByText("Beta")).toBeInTheDocument()
})

it("re-pulls the active feed on mount", () => {
  render(<NotificationCenter />)
  expect(hook.refresh).toHaveBeenCalled()
})

it("marks visible unseen notifications as seen when the center opens", () => {
  hook.items = [
    rec({ id: "unseen", readState: "unseen" }),
    rec({ id: "seen", readState: "seen" }),
    rec({ id: "read", readState: "read" }),
  ]
  render(<NotificationCenter />)
  expect(hook.markSeen).toHaveBeenCalledTimes(1)
  expect(hook.markSeen).toHaveBeenCalledWith("unseen")
})

it("marks only the filtered first page as seen", () => {
  hook.sourceFilter = "scheduler"
  hook.items = [
    rec({ id: "hidden", source: "connector", readState: "unseen" }),
    ...Array.from({ length: 21 }, (_, index) =>
      rec({ id: `visible-${index}`, source: "scheduler", readState: "unseen" })
    ),
  ]

  render(<NotificationCenter />)

  expect(hook.markSeen.mock.calls.map(([id]) => id)).toEqual(
    Array.from({ length: 20 }, (_, index) => `visible-${index}`)
  )
})

it("mark-all-read button calls the store", async () => {
  hook.items = [rec()]
  render(<NotificationCenter />)
  await userEvent.click(
    screen.getByRole("button", { name: "notificationCenter.center.markAllRead" })
  )
  expect(hook.markAllRead).toHaveBeenCalled()
})

it("opening a notification navigates and marks it read", async () => {
  hook.items = [rec({ id: "a", title: "Alpha", href: "/inbox/c/x" })]
  const onNavigate = jest.fn()
  render(<NotificationCenter onNavigate={onNavigate} />)
  await userEvent.click(screen.getByText("Alpha"))
  expect(hook.markRead).toHaveBeenCalledWith("a")
  expect(push).toHaveBeenCalledWith("/inbox/c/x")
  expect(onNavigate).toHaveBeenCalled()
})

it("inline action dispatches the command and marks read", async () => {
  hook.items = [
    rec({ id: "a", title: "Alpha", actions: [{ id: "x", label: "Approve", command: "approve" }] }),
  ]
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "Approve" }))
  expect(dispatchCmd).toHaveBeenCalledWith(
    expect.objectContaining({ notificationId: "a", command: "approve" })
  )
  expect(hook.markRead).toHaveBeenCalledWith("a")
})

it("settings button navigates to the notifications settings section", async () => {
  const onNavigate = jest.fn()
  render(<NotificationCenter onNavigate={onNavigate} />)
  await userEvent.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  expect(push).toHaveBeenCalledWith("/settings?section=notifications")
  expect(onNavigate).toHaveBeenCalled()
})

it("source filter selects a source", async () => {
  const user = userEvent.setup()
  render(<NotificationCenter />)
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.filterAll" }))
  await user.click(await screen.findByText("notificationCenter.sources.scheduler"))
  expect(hook.setSourceFilter).toHaveBeenCalledWith("scheduler")
})

it("filters active notifications by source", () => {
  hook.sourceFilter = "scheduler"
  hook.items = [
    rec({ id: "scheduled", source: "scheduler", title: "Scheduled" }),
    rec({ id: "message", source: "connector", title: "Message" }),
  ]

  render(<NotificationCenter />)

  expect(screen.getByText("Scheduled")).toBeInTheDocument()
  expect(screen.queryByText("Message")).not.toBeInTheDocument()
})

it("toggling 'show archived' loads done notifications", async () => {
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "notificationCenter.center.archived" }))
  expect(listDone).toHaveBeenCalledWith(
    expect.objectContaining({ includeDone: true, readStates: ["done"] })
  )
})

it("restores an archived notification to the active feed", async () => {
  const user = userEvent.setup()
  listDone.mockResolvedValueOnce([
    rec({ id: "archived", title: "Archived item", readState: "done" }),
  ])
  render(<NotificationCenter />)

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.archived" }))
  expect(await screen.findByText("Archived item")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.center.restore"))

  expect(hook.restore).toHaveBeenCalledWith("archived")
})

it("filters archived notifications by source and switches back to the inbox", async () => {
  const user = userEvent.setup()
  hook.sourceFilter = "scheduler"
  listDone.mockResolvedValueOnce([
    rec({ id: "scheduled", source: "scheduler", title: "Scheduled", readState: "done" }),
    rec({ id: "message", source: "connector", title: "Message", readState: "done" }),
  ])
  render(<NotificationCenter />)

  expect(
    screen.getByRole("button", { name: "notificationCenter.sources.scheduler" })
  ).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.archived" }))
  expect(await screen.findByText("Scheduled")).toBeInTheDocument()
  expect(screen.queryByText("Message")).not.toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.active" }))
  expect(screen.getByRole("button", { name: "notificationCenter.center.active" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

it("shows an unread count badge for the active feed", () => {
  hook.items = [rec({ id: "a", readState: "unseen" }), rec({ id: "b", readState: "read" })]
  render(<NotificationCenter />)
  const badge = screen.getByTestId("notification-center-unread")
  expect(badge).toHaveTextContent("1")
})

it("hides the unread badge when everything is read", () => {
  hook.items = [rec({ id: "a", readState: "read" })]
  render(<NotificationCenter />)
  expect(screen.queryByTestId("notification-center-unread")).not.toBeInTheDocument()
})

it("caps the center unread count at 99+", () => {
  hook.items = Array.from({ length: 100 }, (_, index) =>
    rec({ id: `unread-${index}`, readState: "unseen" })
  )
  render(<NotificationCenter />)
  expect(screen.getByTestId("notification-center-unread")).toHaveTextContent("99+")
})

it("groups notifications into dated buckets", () => {
  const dayMs = 24 * 60 * 60 * 1000
  hook.items = [
    rec({ id: "t", title: "TodayOne", createdAt: Date.now() }),
    rec({ id: "e", title: "OldOne", createdAt: Date.now() - 5 * dayMs }),
  ]
  render(<NotificationCenter />)
  expect(screen.getByTestId("notification-bucket-today")).toBeInTheDocument()
  expect(screen.getByTestId("notification-bucket-earlier")).toBeInTheDocument()
})

it("archive-all menu item archives the active feed", async () => {
  const user = userEvent.setup()
  hook.items = [rec()]
  render(<NotificationCenter />)
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.moreActions" }))
  await user.click(await screen.findByText("notificationCenter.center.archiveAll"))
  expect(hook.archiveAll).toHaveBeenCalled()
})

it("clear-all asks for confirmation before wiping", async () => {
  const user = userEvent.setup()
  hook.items = [rec()]
  render(<NotificationCenter />)
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.moreActions" }))
  await user.click(await screen.findByText("notificationCenter.center.clearAll"))
  // Dialog is shown; nothing cleared yet.
  expect(hook.clearAll).not.toHaveBeenCalled()
  await user.click(
    await screen.findByRole("button", { name: "notificationCenter.center.clearAllConfirm" })
  )
  expect(hook.clearAll).toHaveBeenCalled()
})

it("cancelling the clear-all dialog does not wipe", async () => {
  const user = userEvent.setup()
  hook.items = [rec()]
  render(<NotificationCenter />)
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.moreActions" }))
  await user.click(await screen.findByText("notificationCenter.center.clearAll"))
  await user.click(
    await screen.findByRole("button", { name: "notificationCenter.center.clearAllCancel" })
  )
  expect(hook.clearAll).not.toHaveBeenCalled()
})

it("wires per-row triage actions (mark read / archive / snooze / remove) to the store", async () => {
  const user = userEvent.setup()
  hook.items = [rec({ id: "a", title: "Alpha", readState: "unseen" })]
  render(<NotificationCenter />)
  const row = screen.getByTestId("notification-item")
  const openMenu = () =>
    user.click(within(row).getByRole("button", { name: "notificationCenter.center.itemActions" }))

  await openMenu()
  await user.click(await screen.findByText("notificationCenter.center.markRead"))
  expect(hook.markRead).toHaveBeenCalledWith("a")

  await openMenu()
  await user.click(await screen.findByText("notificationCenter.center.markDone"))
  expect(hook.markDone).toHaveBeenCalledWith("a")

  await openMenu()
  await user.click(await screen.findByText("notificationCenter.snoozePresets.15m"))
  expect(hook.snooze).toHaveBeenCalledWith("a", expect.any(Number))

  await openMenu()
  await user.click(await screen.findByText("notificationCenter.center.remove"))
  expect(hook.remove).toHaveBeenCalledWith("a")
})

it("opening a notification without an href marks it read but does not navigate", async () => {
  hook.items = [rec({ id: "a", title: "Alpha" })]
  render(<NotificationCenter />)
  await userEvent.click(screen.getByText("Alpha"))
  expect(hook.markRead).toHaveBeenCalledWith("a")
  expect(push).not.toHaveBeenCalled()
})

it("paginates with a load-more control", async () => {
  const user = userEvent.setup()
  hook.items = Array.from({ length: 25 }, (_, i) =>
    rec({ id: `n${i}`, title: `Item ${i}`, createdAt: Date.now() - i })
  )
  render(<NotificationCenter />)
  // First page shows 20 of 25.
  expect(screen.getAllByTestId("notification-item")).toHaveLength(20)
  const loadMore = screen.getByTestId("notification-load-more")
  expect(loadMore).toHaveTextContent("5")
  await user.click(loadMore)
  expect(screen.getAllByTestId("notification-item")).toHaveLength(25)
  expect(screen.queryByTestId("notification-load-more")).not.toBeInTheDocument()
})
