/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

// next-intl is globally mocked in jest.setup.ts to resolve real
// i18n/messages/en.json keys, so we assert against the canonical English
// strings (no NextIntlClientProvider wrapper required).

jest.mock("@/components/mobile/notifications/notification-permission-cta", () => ({
  NotificationPermissionCta: () => <div data-testid="notification-permission-cta-stub">cta</div>,
}))

jest.mock("@/components/mobile/notifications/notifications-queue-sheet", () => ({
  NotificationsQueueSheet: ({ open }: { open: boolean }) => (
    <div data-testid="notifications-queue-sheet-stub" data-open={String(open)} />
  ),
}))

import { NotificationsSection } from "./notifications-section"

describe("<NotificationsSection />", () => {
  it("renders the title, description, CTA, and queue entry", () => {
    render(<NotificationsSection />)
    expect(screen.getByText("Notifications")).toBeInTheDocument()
    expect(screen.getByText(/Background reminders for scheduled backups/)).toBeInTheDocument()
    expect(screen.getByTestId("notification-permission-cta-stub")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-settings-notifications-queue-entry")).toBeInTheDocument()
    expect(screen.getByText("Scheduled notifications")).toBeInTheDocument()
  })

  it("clicking the queue row opens the queue sheet", () => {
    render(<NotificationsSection />)
    expect(screen.getByTestId("notifications-queue-sheet-stub")).toHaveAttribute(
      "data-open",
      "false"
    )
    fireEvent.click(screen.getByTestId("mobile-settings-notifications-queue-entry"))
    expect(screen.getByTestId("notifications-queue-sheet-stub")).toHaveAttribute(
      "data-open",
      "true"
    )
  })

  it("pressing Enter on the queue row opens the queue sheet", () => {
    render(<NotificationsSection />)
    fireEvent.keyDown(screen.getByTestId("mobile-settings-notifications-queue-entry"), {
      key: "Enter",
    })
    expect(screen.getByTestId("notifications-queue-sheet-stub")).toHaveAttribute(
      "data-open",
      "true"
    )
  })

  it("pressing Space on the queue row opens the queue sheet", () => {
    render(<NotificationsSection />)
    fireEvent.keyDown(screen.getByTestId("mobile-settings-notifications-queue-entry"), {
      key: " ",
    })
    expect(screen.getByTestId("notifications-queue-sheet-stub")).toHaveAttribute(
      "data-open",
      "true"
    )
  })

  it("ignores other keys", () => {
    render(<NotificationsSection />)
    fireEvent.keyDown(screen.getByTestId("mobile-settings-notifications-queue-entry"), {
      key: "Escape",
    })
    expect(screen.getByTestId("notifications-queue-sheet-stub")).toHaveAttribute(
      "data-open",
      "false"
    )
  })
})
