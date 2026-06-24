import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationRecord } from "@/types/notifications"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
  useFormatter: () => ({ relativeTime: () => "2 minutes ago" }),
  useNow: () => new Date("2024-01-01T00:00:00Z"),
}))

import { NotificationItem } from "./notification-item"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    source: "connector",
    level: "info",
    title: "Hello",
    body: "World body",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    ...over,
  }
}

function setup(over: Partial<NotificationRecord> = {}) {
  const handlers = {
    onOpen: jest.fn(),
    onMarkRead: jest.fn(),
    onMarkDone: jest.fn(),
    onSnooze: jest.fn(),
    onRemove: jest.fn(),
    onAction: jest.fn(),
  }
  render(<NotificationItem record={rec(over)} {...handlers} />)
  return handlers
}

it("renders title, body, and source label", () => {
  setup()
  expect(screen.getByText("Hello")).toBeInTheDocument()
  expect(screen.getByText("World body")).toBeInTheDocument()
  expect(screen.getByText("notificationCenter.sources.connector")).toBeInTheDocument()
})

it("shows the coalesced count when > 1", () => {
  setup({ count: 4 })
  expect(screen.getByText(/groupCount.*"count":3/)).toBeInTheDocument()
})

it("marks the row unread for unseen/seen", () => {
  setup({ readState: "seen" })
  expect(screen.getByTestId("notification-item")).toHaveAttribute("data-unread", "true")
})

it("clicking the body calls onOpen", async () => {
  const h = setup()
  await userEvent.click(screen.getByText("Hello"))
  expect(h.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }))
})

it("renders and fires inline action buttons", async () => {
  const h = setup({ actions: [{ id: "a", label: "Approve", command: "approve" }] })
  await userEvent.click(screen.getByRole("button", { name: "Approve" }))
  expect(h.onAction).toHaveBeenCalledWith(
    expect.objectContaining({ id: "n1" }),
    "approve",
    undefined
  )
})

it("row menu fires mark-read, archive and remove", async () => {
  const user = userEvent.setup()
  const h = setup({ readState: "unseen" })
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  await user.click(await screen.findByText("notificationCenter.center.markRead"))
  expect(h.onMarkRead).toHaveBeenCalledWith("n1")

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  await user.click(await screen.findByText("notificationCenter.center.markDone"))
  expect(h.onMarkDone).toHaveBeenCalledWith("n1")

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  await user.click(await screen.findByText("notificationCenter.center.remove"))
  expect(h.onRemove).toHaveBeenCalledWith("n1")
})

it("snooze submenu fires onSnooze with a preset duration", async () => {
  const user = userEvent.setup()
  const h = setup()
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.settings" }))
  await user.click(await screen.findByText("notificationCenter.snoozePresets.1h"))
  expect(h.onSnooze).toHaveBeenCalledWith("n1", 60 * 60 * 1000)
})
