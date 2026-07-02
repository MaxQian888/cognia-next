/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/sections/diagnostics-section", () => ({
  DiagnosticsSection: () => <div data-testid="stub-diagnostics" />,
}))

import Page from "./page"

describe("MobileDiagnosticsPage", () => {
  it("renders the Diagnostics section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-diagnostics-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-diagnostics")).toBeInTheDocument()
  })
})
