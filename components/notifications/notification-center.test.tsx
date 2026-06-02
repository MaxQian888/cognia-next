import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationRecord } from "@/types/notifications"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
  useFormatter: () => ({ relativeTime: () => "now" }),
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
  markRead: jest.fn(),
  markDone: jest.fn(),
  markAllRead: jest.fn(),
  snooze: jest.fn(),
  remove: jest.fn(),
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
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  expect(push).toHaveBeenCalledWith("/settings?section=notifications")
})

it("source filter selects a source", async () => {
  const user = userEvent.setup()
  render(<NotificationCenter />)
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.filterAll" }))
  await user.click(await screen.findByText("notificationCenter.sources.scheduler"))
  expect(hook.setSourceFilter).toHaveBeenCalledWith("scheduler")
})

it("toggling 'show archived' loads done notifications", async () => {
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "notificationCenter.center.showDone" }))
  expect(listDone).toHaveBeenCalledWith(
    expect.objectContaining({ includeDone: true, readStates: ["done"] })
  )
})
