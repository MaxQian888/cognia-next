/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/companion/paired-devices-card", () => ({
  PairedDevicesCard: () => <div data-testid="stub-paired-devices" />,
}))

import Page from "./page"

describe("MobileDevicesPage", () => {
  it("renders the SubPageShell with the paired-devices card inside", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-devices-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-paired-devices")).toBeInTheDocument()
  })
})
