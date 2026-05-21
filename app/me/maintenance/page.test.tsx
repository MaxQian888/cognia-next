/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/data/tabs/maintenance-tab", () => ({
  MaintenanceTab: () => <div data-testid="stub-maintenance" />,
}))

import Page from "./page"

describe("MobileMaintenancePage", () => {
  it("renders the maintenance tab inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-maintenance-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-maintenance")).toBeInTheDocument()
  })
})
