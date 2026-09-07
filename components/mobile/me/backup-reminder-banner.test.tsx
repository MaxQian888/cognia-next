/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { BackupReminderBanner } from "./backup-reminder-banner"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    key === "bodyKnownLast" ? `last ${vars?.days}d ago` : key,
}))

const reminderMock = jest.fn()
jest.mock("@/hooks/data/use-backup-reminder", () => ({
  useBackupReminder: () => reminderMock(),
}))

const latestMock = jest.fn()
jest.mock("@/hooks/data/use-backup-history", () => ({
  useLatestSuccessfulBackup: () => latestMock(),
}))

const dismiss = jest.fn()

beforeEach(() => {
  dismiss.mockReset()
  reminderMock.mockReset().mockReturnValue({ visible: true, dismiss })
  latestMock.mockReset().mockReturnValue(undefined)
})

describe("<BackupReminderBanner />", () => {
  it("renders nothing when the reminder is not visible", () => {
    reminderMock.mockReturnValue({ visible: false, dismiss })
    const { container } = render(<BackupReminderBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("announces itself as a status alert rather than a bare bordered box", () => {
    // An icon, a title, a reason and two actions tinted amber IS the alert
    // shape, and the primitive brings the announcement semantics a plain frame
    // never had. `status` rather than the assertive default, because a backup
    // nudge should not interrupt whatever a screen reader is already saying.
    const { container } = render(<BackupReminderBanner />)
    const banner = screen.getByTestId("backup-reminder-banner")
    expect(banner).toHaveAttribute("role", "status")
    expect(banner).toHaveAttribute("data-slot", "alert")
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
  })

  it("links the CTA to /me/backup", () => {
    render(<BackupReminderBanner />)
    expect(screen.getByTestId("backup-reminder-cta")).toHaveAttribute("href", "/me/backup")
  })

  it('shows the "never backed up" body when there is no successful backup', () => {
    render(<BackupReminderBanner />)
    expect(screen.getByTestId("backup-reminder-banner")).toHaveTextContent("bodyNeverBackedUp")
  })

  it('shows the "N days ago" body when there is a successful backup', () => {
    latestMock.mockReturnValue({ completedAt: Date.now() - 9 * 24 * 60 * 60 * 1000 })
    render(<BackupReminderBanner />)
    expect(screen.getByTestId("backup-reminder-banner")).toHaveTextContent(/last 9d ago/)
  })

  it("calls dismiss when the dismiss button is clicked", () => {
    render(<BackupReminderBanner />)
    fireEvent.click(screen.getByTestId("backup-reminder-dismiss"))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
