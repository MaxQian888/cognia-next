/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/mobile/me/device-info-card", () => ({
  DeviceInfoCard: () => <div data-testid="stub-device-info" />,
}))

import Page from "./page"

describe("MobileDeviceInfoPage", () => {
  it("renders the device info card inside the SubPageShell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-device-info-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-device-info")).toBeInTheDocument()
  })
})
