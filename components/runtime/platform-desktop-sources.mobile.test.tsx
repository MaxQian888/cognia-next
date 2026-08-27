/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"

import { PlatformDesktopSources } from "./platform-desktop-sources.mobile"

describe("PlatformDesktopSources (Capacitor variant)", () => {
  it("passes children through untouched", () => {
    const { container } = render(
      <PlatformDesktopSources>
        <p>app</p>
      </PlatformDesktopSources>
    )
    expect(screen.getByText("app")).toBeInTheDocument()
    expect(container.firstElementChild?.tagName).toBe("P")
  })

  /** The phone consumes companion deltas, it never produces them. */
  it("pulls no desktop bridge graph into the Capacitor bundle", () => {
    const source = readFileSync(join(__dirname, "platform-desktop-sources.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/^import /m)
  })
})
