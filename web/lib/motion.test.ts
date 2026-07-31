import { readFileSync } from "node:fs"
import { join } from "node:path"
import { EASE_ENTRANCE, EASE_ENTRANCE_CSS } from "./motion"

describe("motion constants", () => {
  it("exposes the entrance curve as a four-point cubic bezier", () => {
    expect(EASE_ENTRANCE).toEqual([0.22, 0.61, 0.36, 1])
  })

  it("renders the same curve as a CSS timing function", () => {
    expect(EASE_ENTRANCE_CSS).toBe("cubic-bezier(0.22, 0.61, 0.36, 1)")
  })

  // The whole point of the module: the stylesheet and the motion components
  // must not drift apart again. `globals.css` declares the token once and
  // every CSS user reads it through `var(--ease-entrance)`.
  it("matches the --ease-entrance token declared in globals.css", () => {
    const css = readFileSync(join(process.cwd(), "web/app/globals.css"), "utf8")
    const declared = /--ease-entrance:\s*([^;]+);/.exec(css)
    expect(declared).not.toBeNull()
    expect(declared![1].trim()).toBe(EASE_ENTRANCE_CSS)
  })

  it("leaves no raw copy of the curve anywhere else in the stylesheet", () => {
    const css = readFileSync(join(process.cwd(), "web/app/globals.css"), "utf8")
    const occurrences = css.match(/cubic-bezier\(0\.22,\s*0\.61,\s*0\.36,\s*1\)/g) ?? []
    // Exactly one: the token declaration itself.
    expect(occurrences).toHaveLength(1)
  })
})
