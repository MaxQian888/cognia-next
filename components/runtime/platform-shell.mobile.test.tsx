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

import { PlatformShell } from "./platform-shell.mobile"

describe("PlatformShell (Capacitor variant)", () => {
  it("renders the routed children inside the mobile wrapper", () => {
    render(
      <PlatformShell>
        <p>routed</p>
      </PlatformShell>
    )
    expect(screen.getByTestId("mobile-shell-wrapper")).toContainElement(screen.getByText("routed"))
  })

  /**
   * The only reason this variant exists: keeping the desktop chrome graph —
   * title bar, guild rail, status bar, command palette, terminal dock,
   * extension-host bar — out of the phone bundle. An import added here would
   * pull all of it back in while every test still passed.
   */
  it("pulls no desktop chrome into the Capacitor bundle", () => {
    const source = readFileSync(join(__dirname, "platform-shell.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/from\s+["'][^"']*desktop-app-shell["']/)
    expect(source).not.toMatch(/from\s+["']@\/components\/desktop\//)
  })
})
