/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginMarketplaceModeBanner } from "./plugin-marketplace-mode-banner"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The banner reads sourceState.mode from the persistent zustand store. Mock
// the selector to return the value we want each test to drive.
jest.mock("@/stores/plugin-runtime/plugin-marketplace-store", () => ({
  usePluginMarketplaceStore: (selector: (state: unknown) => unknown) =>
    selector({ sourceState: { mode: "remote" } }),
}))

describe("PluginMarketplaceModeBanner", () => {
  it("renders nothing for remote mode (override)", () => {
    const { container } = render(<PluginMarketplaceModeBanner mode="remote" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the degraded banner when mode override is 'degraded'", () => {
    render(<PluginMarketplaceModeBanner mode="degraded" />)
    const banner = screen.getByTestId("plugin-marketplace-mode-banner-degraded")
    expect(banner).toHaveAttribute("data-slot", "alert")
    expect(banner.querySelector("[data-slot='alert-title']")).not.toBeNull()
    expect(banner.querySelector("[data-slot='alert-description']")).not.toBeNull()
    expect(screen.getByText("degradedTitle")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-marketplace-mode-banner-demo")).not.toBeInTheDocument()
  })

  it("renders the demo banner when mode override is 'demo'", () => {
    render(<PluginMarketplaceModeBanner mode="demo" />)
    expect(screen.getByTestId("plugin-marketplace-mode-banner-demo")).toBeInTheDocument()
    expect(screen.getByText("demoTitle")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-marketplace-mode-banner-degraded")).not.toBeInTheDocument()
  })

  it("forwards className to the banner alert", () => {
    const { container } = render(
      <PluginMarketplaceModeBanner mode="degraded" className="custom-banner" />
    )
    expect(container.querySelector(".custom-banner")).not.toBeNull()
  })

  it("falls back to the store's mode when no override is provided", () => {
    // Default mock returns "remote" → nothing renders.
    const { container } = render(<PluginMarketplaceModeBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})
