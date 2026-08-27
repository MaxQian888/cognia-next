/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"

jest.mock("@/components/providers/initializers/desktop-only-initializers", () => ({
  DesktopOnlyInitializers: () => <div data-testid="desktop-only-initializers" />,
}))

import { PlatformDesktopInitializers } from "./platform-desktop-initializers"

describe("PlatformDesktopInitializers (default variant)", () => {
  it("mounts the desktop boot bundle", () => {
    render(<PlatformDesktopInitializers />)
    expect(screen.getByTestId("desktop-only-initializers")).toBeInTheDocument()
  })

  /**
   * `pnpm tauri dev` builds this variant — its frontend is plain `pnpm dev`.
   * Dropping the mount here would leave the desktop shell with no terminal
   * bridge, CLI bridge, updater, deep-link routers, tray panel or crash
   * dialog, and only in dev, where nothing would fail loudly.
   */
  it("is the mount point the desktop shell depends on", () => {
    const source = readFileSync(join(__dirname, "platform-desktop-initializers.tsx"), "utf8")
    expect(source).toContain("initializers/desktop-only-initializers")
  })
})
