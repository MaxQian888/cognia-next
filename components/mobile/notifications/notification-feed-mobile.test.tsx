import { render, screen } from "@testing-library/react"
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

const hook = {
  items: [] as NotificationRecord[],
  markRead: jest.fn(),
  markDone: jest.fn(),
  markAllRead: jest.fn(),
  snooze: jest.fn(),
  remove: jest.fn(),
  refresh: jest.fn().mockResolvedValue(undefined),
}
jest.mock("@/hooks/notifications/use-notifications", () => ({ useNotifications: () => hook }))

import { NotificationFeedMobile } from "./notification-feed-mobile"

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
})

it("shows the empty state when there are no notifications", () => {
  render(<NotificationFeedMobile />)
  expect(screen.getByTestId("notification-feed-empty")).toBeInTheDocument()
})

it("refreshes the feed on mount", () => {
  render(<NotificationFeedMobile />)
  expect(hook.refresh).toHaveBeenCalled()
})

it("renders items and shows the row menu without hover (touch)", () => {
  hook.items = [rec({ title: "Alpha" })]
  render(<NotificationFeedMobile />)
  expect(screen.getByText("Alpha")).toBeInTheDocument()
  const menu = screen.getByRole("button", { name: "notificationCenter.center.settings" })
  expect(menu.className).toContain("opacity-100")
  expect(menu.className).not.toContain("opacity-0")
})

it("mark-all-read calls the store", async () => {
  hook.items = [rec()]
  render(<NotificationFeedMobile />)
  await userEvent.click(screen.getByRole("button", { name: "notificationCenter.center.markAllRead" }))
  expect(hook.markAllRead).toHaveBeenCalled()
})

it("opening a notification navigates and marks read", async () => {
  hook.items = [rec({ id: "a", title: "Alpha", href: "/inbox/c/x" })]
  render(<NotificationFeedMobile />)
  await userEvent.click(screen.getByText("Alpha"))
  expect(hook.markRead).toHaveBeenCalledWith("a")
  expect(push).toHaveBeenCalledWith("/inbox/c/x")
})

it("refresh button re-pulls", async () => {
  render(<NotificationFeedMobile />)
  await userEvent.click(screen.getByRole("button", { name: "refresh" }))
  expect(hook.refresh).toHaveBeenCalledTimes(2) // mount + click
})
