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
  it("renders the SubPageShell + embeds the shared section", () => {
    render(<MobileAppearancePage />)
    expect(screen.getByTestId("mobile-appearance-page")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-sub-page-back")).toBeInTheDocument()
    expect(screen.getByTestId("stub-appearance-section")).toBeInTheDocument()
  })

  it("renders the localized section heading", () => {
    render(<MobileAppearancePage />)
    // next-intl is globally mocked to resolve real en.json keys, so the
    // heading reflects `mobile.me.sectionAppearance`.
    expect(screen.getByRole("heading", { level: 1, name: /appearance/i })).toBeInTheDocument()
  })
})
