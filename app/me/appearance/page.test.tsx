/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

// The route page composes the heavy `<AppearanceSection />` via dynamic
// imports (six tabs, contrast audit, theme storage). Stub it here so the
// route's own header + suspense fallback are the unit under test.
jest.mock("@/components/settings/appearance", () => ({
  AppearanceSection: () => <div data-testid="stub-appearance-section">section</div>,
}))

import MobileAppearancePage from "./page"

describe("MobileAppearancePage", () => {
  it("renders the back-to-me header and embeds the shared section", () => {
    render(<MobileAppearancePage />)
    expect(screen.getByTestId("mobile-appearance-page")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-appearance-back")).toBeInTheDocument()
    expect(screen.getByTestId("stub-appearance-section")).toBeInTheDocument()
  })

  it("links the back button to /me", () => {
    render(<MobileAppearancePage />)
    const back = screen.getByTestId("mobile-appearance-back")
    // `asChild` lifts the Link's href onto the rendered Button anchor.
    expect(back.querySelector("a")?.getAttribute("href") ?? back.getAttribute("href")).toBe("/me")
  })

  it("renders the localized section heading", () => {
    render(<MobileAppearancePage />)
    // The mock next-intl loader resolves keys against the real en.json,
    // so the heading reflects `mobile.me.sectionAppearance`.
    expect(screen.getByRole("heading", { level: 1, name: /appearance/i })).toBeInTheDocument()
  })
})
