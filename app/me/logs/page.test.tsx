/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/sections/logs-section", () => ({
  LogsSection: () => <div data-testid="stub-logs" />,
}))

import Page from "./page"

describe("MobileLogsPage", () => {
  it("renders the Logs section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-logs-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-logs")).toBeInTheDocument()
  })
})
