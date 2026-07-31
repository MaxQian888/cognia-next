import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

const counts = { directedUnread: 0, ambientUnseen: 0 }
jest.mock("@/hooks/notifications/use-notifications", () => ({ useNotifications: () => counts }))

// Stub the heavy center so the bell test stays focused on the badge/trigger.
jest.mock("./notification-center", () => ({
  NotificationCenter: ({ onNavigate }: { onNavigate?: () => void }) => (
    <button type="button" data-testid="center-stub" onClick={onNavigate}>
      Center
    </button>
  ),
}))

import { NotificationBell } from "./notification-bell"

beforeEach(() => {
  counts.directedUnread = 0
  counts.ambientUnseen = 0
})

it("shows no badge when there is nothing unread", () => {
  render(<NotificationBell />)
  expect(screen.queryByTestId("notification-badge-count")).not.toBeInTheDocument()
  expect(screen.queryByTestId("notification-badge-dot")).not.toBeInTheDocument()
})

it("shows a red numeric badge for directed-unread", () => {
  counts.directedUnread = 3
  render(<NotificationBell />)
  expect(screen.getByTestId("notification-badge-count")).toHaveTextContent("3")
  expect(screen.queryByTestId("notification-badge-dot")).not.toBeInTheDocument()
})

it("caps the numeric badge at 99+", () => {
  counts.directedUnread = 250
  render(<NotificationBell />)
  expect(screen.getByTestId("notification-badge-count")).toHaveTextContent("99+")
})

it("shows an ambient dot when there is only ambient activity", () => {
  counts.ambientUnseen = 5
  render(<NotificationBell />)
  expect(screen.getByTestId("notification-badge-dot")).toBeInTheDocument()
  expect(screen.queryByTestId("notification-badge-count")).not.toBeInTheDocument()
})

it("directed badge takes precedence over the ambient dot", () => {
  counts.directedUnread = 1
  counts.ambientUnseen = 5
  render(<NotificationBell />)
  expect(screen.getByTestId("notification-badge-count")).toBeInTheDocument()
  expect(screen.queryByTestId("notification-badge-dot")).not.toBeInTheDocument()
})

it("opens the center on click", async () => {
  render(<NotificationBell />)
  await userEvent.click(screen.getByTestId("status-notifications"))
  expect(await screen.findByTestId("center-stub")).toBeInTheDocument()
})

it("constrains the popover content to the viewport", async () => {
  render(<NotificationBell />)
  await userEvent.click(screen.getByTestId("status-notifications"))
  const content = await screen.findByTestId("center-stub")
  expect(content.parentElement).toHaveClass("max-w-[calc(100vw-0.5rem)]", "overflow-hidden", "p-0")
})

it("closes the popover after the center navigates", async () => {
  render(<NotificationBell />)
  await userEvent.click(screen.getByTestId("status-notifications"))
  await userEvent.click(await screen.findByTestId("center-stub"))
  expect(screen.queryByTestId("center-stub")).not.toBeInTheDocument()
})

it("labels the trigger with the unread count when directed", () => {
  counts.directedUnread = 2
  render(<NotificationBell />)
  expect(
    screen.getByRole("button", { name: 'notificationCenter.bell.unreadAria:{"count":2}' })
  ).toBeInTheDocument()
})
