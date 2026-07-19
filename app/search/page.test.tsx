/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

// The panel pulls the standalone runner (AI SDK) — stub it so the page test
// stays focused on the shell wiring.
jest.mock("@/components/search/standalone-search-panel", () => ({
  StandaloneSearchPanel: () => <div data-testid="standalone-search-panel" />,
}))

import Page from "./page"

describe("StandaloneSearchPage", () => {
  it("renders the panel inside the sub-page shell", () => {
    render(<Page />)
    expect(screen.getByTestId("standalone-search-page")).toBeInTheDocument()
    expect(screen.getByTestId("standalone-search-panel")).toBeInTheDocument()
  })

  it("renders the shared back control with the localized label", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-sub-page-back")).toHaveAccessibleName("Back to Me")
  })
})
