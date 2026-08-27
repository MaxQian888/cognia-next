/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"

jest.mock("@/components/providers/desktop-sync-source-provider", () => ({
  DesktopSyncSourceProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="desktop-sync-source">{children}</div>
  ),
}))
jest.mock("@/components/providers/desktop-message-source-provider", () => ({
  DesktopMessageSourceProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="desktop-message-source">{children}</div>
  ),
}))

import { PlatformDesktopSources } from "./platform-desktop-sources"

describe("PlatformDesktopSources (default variant)", () => {
  it("mounts both companion source providers around the children", () => {
    render(
      <PlatformDesktopSources>
        <p>app</p>
      </PlatformDesktopSources>
    )
    const sync = screen.getByTestId("desktop-sync-source")
    const message = screen.getByTestId("desktop-message-source")
    expect(sync).toContainElement(message)
    expect(message).toContainElement(screen.getByText("app"))
  })

  /**
   * Web and Tauri consume the same `out/`, so the desktop bridges have to be
   * present in this variant — they gate themselves on `usePlatform()`, and
   * `pnpm tauri dev` builds exactly this file.
   */
  it("keeps the Tauri bridges in the bundle web and Tauri share", () => {
    const source = readFileSync(join(__dirname, "platform-desktop-sources.tsx"), "utf8")
    expect(source).toContain("desktop-sync-source-provider")
    expect(source).toContain("desktop-message-source-provider")
  })
})
