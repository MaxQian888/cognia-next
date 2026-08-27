/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render } from "@testing-library/react"

import { PlatformDesktopInitializers } from "./platform-desktop-initializers.mobile"

describe("PlatformDesktopInitializers (Capacitor variant)", () => {
  it("renders nothing", () => {
    const { container } = render(<PlatformDesktopInitializers />)
    expect(container).toBeEmptyDOMElement()
  })

  /** `isTauri()` is false on Capacitor, so the chunks could only render null. */
  it("emits none of the desktop initializer chunks into the phone bundle", () => {
    const source = readFileSync(join(__dirname, "platform-desktop-initializers.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/^import /m)
  })
})
