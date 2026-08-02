/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, values?: Record<string, unknown>) =>
    values ? `${k}:${JSON.stringify(values)}` : k,
  useLocale: () => "en",
}))

import { CursorRolePreview, formatRoleList, splitRoles } from "./cursor-role-preview"
import { CURSOR_PACKS_BY_ID } from "@/lib/appearance/cursor/cursor-packs"
import { CURSOR_ROLES } from "@/types/appearance"

const AERO = CURSOR_PACKS_BY_ID.get("aero")!
const GRAPHITE = CURSOR_PACKS_BY_ID.get("graphite")!

describe("splitRoles", () => {
  it("puts every role on exactly one side", () => {
    const { painted, native } = splitRoles(GRAPHITE)
    expect([...painted, ...native].sort()).toEqual([...CURSOR_ROLES].sort())
    expect(painted.filter((r) => native.includes(r))).toHaveLength(0)
  })

  it("leaves nothing native for a pack that paints everything", () => {
    expect(splitRoles(AERO).native).toHaveLength(0)
  })

  it("preserves the canonical role order", () => {
    const { painted } = splitRoles(AERO)
    expect(painted).toEqual([...CURSOR_ROLES])
  })
})

describe("formatRoleList", () => {
  it("joins with the locale's own conjunction", () => {
    expect(formatRoleList("en", ["Busy", "Crosshair"])).toBe("Busy and Crosshair")
  })

  it("falls back to a comma join when Intl.ListFormat is unavailable", () => {
    const original = Intl.ListFormat
    // `Intl.ListFormat` is a readonly property in the TS lib, so restoring it
    // has to go through defineProperty rather than assignment.
    const restore = () =>
      Object.defineProperty(Intl, "ListFormat", { configurable: true, value: original })
    Object.defineProperty(Intl, "ListFormat", { configurable: true, value: undefined })
    try {
      expect(formatRoleList("en", ["A", "B"])).toBe("A, B")
    } finally {
      restore()
    }
  })
})

describe("CursorRolePreview", () => {
  it("renders one glyph per painted role at the requested size", () => {
    render(<CursorRolePreview pack={AERO} palette={AERO.palette} sizePx={32} />)
    for (const role of AERO.roles) {
      const img = screen.getByTestId(`cursor-role-${role}`)
      expect(img).toHaveAttribute("width", "32")
      expect(img.getAttribute("src")).toContain("data:image/svg+xml,")
    }
  })

  it("names the roles a partial pack hands back to the platform", () => {
    render(<CursorRolePreview pack={GRAPHITE} palette={GRAPHITE.palette} sizePx={24} />)
    const notice = screen.getByTestId("cursor-native-roles")
    expect(notice.textContent).toContain("nativeRoles")
    expect(notice.textContent).toContain("roles.notAllowed")
    expect(screen.queryByTestId("cursor-role-notAllowed")).toBeNull()
  })

  it("says nothing about native roles when the pack paints them all", () => {
    render(<CursorRolePreview pack={AERO} palette={AERO.palette} sizePx={24} />)
    expect(screen.queryByTestId("cursor-native-roles")).toBeNull()
  })

  it("repaints when the size changes, so the slider has visible consequences", () => {
    const { rerender } = render(
      <CursorRolePreview pack={AERO} palette={AERO.palette} sizePx={24} />
    )
    const small = screen.getByTestId("cursor-role-default").getAttribute("src")
    rerender(<CursorRolePreview pack={AERO} palette={AERO.palette} sizePx={48} />)
    expect(screen.getByTestId("cursor-role-default").getAttribute("src")).not.toBe(small)
  })
})
