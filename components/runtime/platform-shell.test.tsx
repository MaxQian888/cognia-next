/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"

jest.mock("@/components/mobile/shell/mobile-shell-wrapper", () => ({
  MobileShellWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mobile-shell-wrapper">{children}</div>
  ),
}))
jest.mock("@/components/desktop/desktop-app-shell", () => ({
  DesktopAppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="desktop-app-shell">{children}</div>
  ),
}))

import { PlatformShell } from "./platform-shell"

describe("PlatformShell (default variant)", () => {
  it("renders the routed children", () => {
    render(
      <PlatformShell>
        <p>routed</p>
      </PlatformShell>
    )
    expect(screen.getByText("routed")).toBeInTheDocument()
  })

  it("nests the desktop shell inside the mobile wrapper, as the layout used to", () => {
    render(
      <PlatformShell>
        <p>routed</p>
      </PlatformShell>
    )
    const mobile = screen.getByTestId("mobile-shell-wrapper")
    const desktop = screen.getByTestId("desktop-app-shell")
    expect(mobile).toContainElement(desktop)
    expect(desktop).toContainElement(screen.getByText("routed"))
  })

  /**
   * `tests/e2e/mobile/**` runs against the WEB build and fakes Capacitor at
   * runtime, so the mobile wrapper has to survive in this variant. Slimming
   * this file down to the desktop shell alone would take the whole mobile
   * layout / tab-bar / keyboard-avoidance suite with it, and nothing else
   * would notice until CI.
   */
  it("keeps both shells in the bundle web and Tauri share", () => {
    const source = readFileSync(join(__dirname, "platform-shell.tsx"), "utf8")
    expect(source).toContain("@/components/mobile/shell/mobile-shell-wrapper")
    expect(source).toContain("@/components/desktop/desktop-app-shell")
  })
})
