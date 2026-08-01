import {
  buildCursorCss,
  CURSOR_ROLE_ORDER,
  CURSOR_ROLE_SELECTORS,
  CURSOR_ROOT_ATTR,
  CURSOR_STYLE_ELEMENT_ID,
} from "./cursor-css"
import { CURSOR_ROLES, type CursorRole } from "@/types/appearance"

function value(role: CursorRole): string {
  return `url("data:image/svg+xml,${role}") 1 2, ${role}`
}

const ALL = CURSOR_ROLES.map((role) => ({ role, value: value(role) }))

describe("CURSOR_ROLE_SELECTORS", () => {
  it("covers every role", () => {
    for (const role of CURSOR_ROLES) {
      expect(CURSOR_ROLE_SELECTORS[role].length).toBeGreaterThan(0)
    }
  })

  it("puts every role in the emission order exactly once", () => {
    expect([...CURSOR_ROLE_ORDER].sort()).toEqual([...CURSOR_ROLES].sort())
  })

  it("targets the Tailwind cursor utilities the app actually writes", () => {
    // Inheritance from <html> loses to an explicit `.cursor-pointer`
    // declaration, so these have to be named or the theme gets punched through.
    expect(CURSOR_ROLE_SELECTORS.pointer).toContain(".cursor-pointer")
    expect(CURSOR_ROLE_SELECTORS.default).toContain(".cursor-default")
    expect(CURSOR_ROLE_SELECTORS.notAllowed).toContain(".cursor-not-allowed")
    expect(CURSOR_ROLE_SELECTORS.grab).toContain(".cursor-grab")
    expect(CURSOR_ROLE_SELECTORS.grabbing).toContain(".cursor-grabbing")
  })

  it("does not use a universal selector, which would stomp resize cursors", () => {
    for (const role of CURSOR_ROLES) {
      for (const selector of CURSOR_ROLE_SELECTORS[role]) {
        expect(selector).not.toBe("*")
        expect(selector.includes("*")).toBe(false)
      }
    }
  })
})

describe("buildCursorCss", () => {
  it("scopes every selector under the root attribute so the sheet is inert without it", () => {
    const css = buildCursorCss(ALL)
    for (const line of css.split("\n")) {
      if (!line.trim() || line.includes("cursor:") || line.trim() === "}") continue
      expect(line).toContain(`html[${CURSOR_ROOT_ATTR}]`)
    }
  })

  it("emits one block per supplied role and nothing for the rest", () => {
    const css = buildCursorCss([{ role: "default", value: value("default") }])
    expect(css).toContain(value("default"))
    expect(css).not.toContain(value("pointer"))
    expect(css.match(/cursor:/g)).toHaveLength(1)
  })

  it("returns an empty string when a pack declares nothing", () => {
    expect(buildCursorCss([])).toBe("")
  })

  it("orders grabbing after grab and notAllowed last, so ties resolve correctly", () => {
    const css = buildCursorCss(ALL)
    expect(css.indexOf(value("grabbing"))).toBeGreaterThan(css.indexOf(value("grab")))
    for (const role of CURSOR_ROLES) {
      if (role === "notAllowed") continue
      expect(css.indexOf(value("notAllowed"))).toBeGreaterThan(css.indexOf(value(role)))
    }
  })

  it("applies the default role to the root itself so inheritance carries it", () => {
    const css = buildCursorCss([{ role: "default", value: value("default") }])
    expect(css).toMatch(new RegExp(`^html\\[${CURSOR_ROOT_ATTR}\\],`))
  })

  it("ignores a role whose value is empty rather than emitting a broken rule", () => {
    const css = buildCursorCss([
      { role: "default", value: "" },
      { role: "pointer", value: value("pointer") },
    ])
    expect(css).not.toContain("cursor: ;")
    expect(css).toContain(value("pointer"))
  })
})

describe("CURSOR_STYLE_ELEMENT_ID", () => {
  it("is a stable id — the applier looks the element up by it on every write", () => {
    expect(CURSOR_STYLE_ELEMENT_ID).toBe("cognia-cursor")
  })
})
