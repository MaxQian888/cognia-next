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
  const h = setup({
    actions: [
      { id: "a", label: "Approve", command: "approve", variant: "primary" },
      { id: "b", label: "Later", command: "later", variant: "secondary" },
    ],
  })
  const primaryAction = screen.getByRole("button", { name: "Approve" })
  expect(primaryAction).toHaveAttribute("data-variant", "default")
  expect(screen.getByRole("button", { name: "Later" })).toHaveAttribute("data-variant", "outline")
  await userEvent.click(primaryAction)
  expect(h.onAction).toHaveBeenCalledWith(
    expect.objectContaining({ id: "n1" }),
    "approve",
    undefined
  )
})

it("keeps the row menu visible when requested by a touch surface", () => {
  render(
    <NotificationItem
      record={rec()}
      onOpen={jest.fn()}
      onMarkRead={jest.fn()}
      onMarkDone={jest.fn()}
      onSnooze={jest.fn()}
      onRemove={jest.fn()}
      onAction={jest.fn()}
      menuAlwaysVisible
    />
  )
  expect(screen.getByRole("button", { name: "notificationCenter.center.itemActions" })).toHaveClass(
    "opacity-100"
  )
})

it("contains long unbroken content and wraps action controls within the row", () => {
  const longText = "x".repeat(160)
  setup({
    title: longText,
    body: longText,
    actions: [{ id: "a", label: longText, command: "approve" }],
  })

  expect(
    screen
      .getAllByText(longText, { selector: "span" })
      .find((element) => element.classList.contains("[overflow-wrap:anywhere]"))
  ).toBeInTheDocument()
  expect(screen.getByText(longText, { selector: "p" })).toHaveClass("[overflow-wrap:anywhere]")
  expect(screen.getByTestId("notification-actions")).toHaveClass("flex-wrap", "min-w-0")
  expect(screen.getByRole("button", { name: longText })).toHaveClass("max-w-full")
})

it("row menu fires mark-read, archive and remove", async () => {
  const user = userEvent.setup()
  const h = setup({ readState: "unseen" })
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.center.markRead"))
  expect(h.onMarkRead).toHaveBeenCalledWith("n1")

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.center.markDone"))
  expect(h.onMarkDone).toHaveBeenCalledWith("n1")

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.center.remove"))
  expect(h.onRemove).toHaveBeenCalledWith("n1")
})

it("snooze submenu fires onSnooze with a preset duration", async () => {
  const user = userEvent.setup()
  const h = setup()
  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.snoozePresets.1h"))
  expect(h.onSnooze).toHaveBeenCalledWith("n1", 60 * 60 * 1000)
})

it("offers restore instead of active-feed triage for archived records", async () => {
  const user = userEvent.setup()
  const onRestore = jest.fn()
  render(
    <NotificationItem
      record={rec({ readState: "done" })}
      onOpen={jest.fn()}
      onMarkRead={jest.fn()}
      onMarkDone={jest.fn()}
      onSnooze={jest.fn()}
      onRemove={jest.fn()}
      onAction={jest.fn()}
      onRestore={onRestore}
      archived
    />
  )

  await user.click(screen.getByRole("button", { name: "notificationCenter.center.itemActions" }))
  await user.click(await screen.findByText("notificationCenter.center.restore"))
  expect(onRestore).toHaveBeenCalledWith("n1")
  expect(screen.queryByText("notificationCenter.center.markDone")).not.toBeInTheDocument()
})
