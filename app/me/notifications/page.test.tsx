/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/mobile/me/notifications-section", () => ({
  NotificationsSection: () => <div data-testid="stub-notifications" />,
}))

import Page from "./page"

describe("MobileNotificationsPage", () => {
  it("renders the notifications section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-notifications-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-notifications")).toBeInTheDocument()
  })
})
