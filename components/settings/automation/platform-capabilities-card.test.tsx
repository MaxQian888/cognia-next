/**
 * @jest-environment jsdom
 *
 * PlatformCapabilitiesCard — the Overview capability readout. The key
 * behaviour under test is the cross-platform accessibility-tree badge that
 * distinguishes a macOS AXAPI back-end (no UIA, but a live a11y tree, which is
 * what unlocks the Inspector) from an input-only enigo back-end.
 */

import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import type { Capabilities } from "@/lib/automation/types"
import { PlatformCapabilitiesCard } from "./platform-capabilities-card"

const base: Capabilities = {
  platform: "windows",
  hasUia: true,
  hasInputSim: true,
  hasScreenshot: true,
  hasEvents: false,
  hasA11yTree: false,
  monitors: [],
}

// jest.setup mocks next-intl against the real en.json bundle, so labels/values
// resolve to their English strings ("Accessibility Tree", "Yes", "No").
function badgeValue(label: string): string {
  const badge = screen.getByText(label).parentElement
  return (badge?.textContent ?? "").replace(label, "")
}

describe("PlatformCapabilitiesCard", () => {
  it("renders a11y-tree = Yes and UIA = No for a macOS back-end", () => {
    const macCaps: Capabilities = {
      ...base,
      platform: "macos",
      hasUia: false,
      hasA11yTree: true,
    }
    render(<PlatformCapabilitiesCard caps={macCaps} />)
    expect(screen.getByText("Platform").parentElement).toHaveTextContent("macos")
    expect(badgeValue("Accessibility Tree")).toBe("Yes")
    expect(badgeValue("UI Automation")).toBe("No")
  })

  it("renders a11y-tree = No and UIA = Yes for a Windows back-end", () => {
    render(<PlatformCapabilitiesCard caps={base} />)
    expect(badgeValue("UI Automation")).toBe("Yes")
    expect(badgeValue("Accessibility Tree")).toBe("No")
    // Events is still forward-looking everywhere.
    expect(badgeValue("Events")).toBe("Planned")
  })

  it("surfaces a probe-failure message when caps is null", () => {
    render(<PlatformCapabilitiesCard caps={null} />)
    expect(screen.getByText(/failed to read platform capabilities/i)).toBeInTheDocument()
    expect(screen.queryByText("Accessibility Tree")).not.toBeInTheDocument()
  })
})
