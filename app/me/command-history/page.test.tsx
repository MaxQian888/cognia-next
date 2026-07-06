/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// The body is exercised by its own test; here we only assert the page wires the
// shell + body together, so stub the client component.
jest.mock("@/components/mobile/mobile-command-history", () => ({
  MobileCommandHistory: () => <div data-testid="mobile-command-history-body" />,
}))

import MobileCommandHistoryPage from "./page"

describe("MobileCommandHistoryPage", () => {
  it("mounts the sub-page shell with the command-history body", () => {
    render(<MobileCommandHistoryPage />)
    expect(screen.getByTestId("mobile-command-history-page")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-command-history-body")).toBeInTheDocument()
  })

  it("shows the localized title and a back affordance", () => {
    render(<MobileCommandHistoryPage />)
    expect(screen.getByRole("heading", { name: "mobile.commandHistory.title" })).toBeInTheDocument()
    expect(screen.getByTestId("mobile-sub-page-back")).toBeInTheDocument()
  })
})
