import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { COMPACT_ABOVE_TAB_BAR_BOTTOM, COMPACT_PAGE_MIN_H, usesCompactShell } from "./compact-shell"

describe("usesCompactShell", () => {
  it("gives the compact shell to a narrow browser tab", () => {
    // The regression this whole split exists for: `platform === "mobile"` said
    // false here, so a 375px browser rendered the desktop workspace.
    expect(usesCompactShell("web", true)).toBe(true)
  })

  it("keeps the desktop shell for a wide browser tab", () => {
    expect(usesCompactShell("web", false)).toBe(false)
  })

  it("always gives the compact shell to a native mobile runtime", () => {
    // Tablet-width Capacitor still wants the phone frame.
    expect(usesCompactShell("mobile", false)).toBe(true)
    expect(usesCompactShell("mobile", true)).toBe(true)
  })

  it("never takes the desktop frame away from Tauri", () => {
    // `decorations: false` means our TitleBar owns the window controls.
    expect(usesCompactShell("tauri", true)).toBe(false)
    expect(usesCompactShell("tauri", false)).toBe(false)
  })

  it("leaves the headless host on the desktop branch", () => {
    expect(usesCompactShell("headless", true)).toBe(false)
  })
})

describe("COMPACT_PAGE_MIN_H", () => {
  it("subtracts the tab-bar reserve the wrapper already added", () => {
    // The wrapper's scrolling branch is `min-h-[100dvh]` PLUS
    // `pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]`, and border-box
    // puts that padding inside the min-height. A body asking for a whole
    // viewport therefore pushes the document one tab bar past the screen.
    expect(COMPACT_PAGE_MIN_H).toBe(
      "min-h-[calc(100dvh-theme(spacing.14)-env(safe-area-inset-bottom))]"
    )
  })

  /**
   * The sweep this constant exists for. `min-h-[100dvh]` on a page body under
   * the compact shell is the bug, not a style choice, and it reappears every
   * time somebody writes a new mobile body from an old one.
   *
   * Scoped to `components/mobile/`: the standalone routes (`/share/view`,
   * `/share-target`) render outside the wrapper and genuinely own the viewport.
   * `MobileShellWrapper` is excluded because it is the box that OWNS the
   * reserve, and its `min-h-[100dvh]` is the number this constant subtracts.
   */
  it("is used instead of min-h-[100dvh] by every compact page body", () => {
    const root = join(__dirname, "..", "..")
    const hits = grep("min-h-\\[100dvh\\]", join(root, "components", "mobile")).filter(
      (file) => !file.includes("mobile-shell-wrapper")
    )
    expect(hits).toEqual([])
  })

  // Guard the guard: an empty walk makes the assertion above vacuously true.
  it("scans a directory that actually contains compact page bodies", () => {
    const root = join(__dirname, "..", "..")
    expect(grep("COMPACT_PAGE_MIN_H", join(root, "components", "mobile")).length).toBeGreaterThan(2)
  })
})

describe("COMPACT_ABOVE_TAB_BAR_BOTTOM", () => {
  it("clears the reserve COMPACT_PAGE_MIN_H subtracts, plus a gap off the bar", () => {
    // Same two terms as the tab bar's own
    // `h-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]`. A floating
    // control offset only by the safe area renders INSIDE that band.
    expect(COMPACT_ABOVE_TAB_BAR_BOTTOM).toBe(
      "bottom-[calc(theme(spacing.14)+env(safe-area-inset-bottom,0px)+1rem)]"
    )
  })

  it("is a complete class literal, not an expression Tailwind cannot see", () => {
    // Tailwind scans source text. A `bottom-[calc(${reserve}+1rem)]` assembled
    // at runtime compiles to no CSS at all and the control silently keeps its
    // default offset.
    expect(COMPACT_ABOVE_TAB_BAR_BOTTOM.startsWith("bottom-[")).toBe(true)
    expect(COMPACT_ABOVE_TAB_BAR_BOTTOM).not.toContain("${")
  })

  /**
   * The sweep. Every control lifted above the tab bar states the reserve once,
   * here — re-inlining it is how the two spellings drift and how the next one
   * gets the arithmetic subtly wrong.
   */
  it("is the only spelling of the lift outside this module", () => {
    const root = join(__dirname, "..", "..")
    const pattern = "bottom-\\[calc\\(theme\\(spacing\\.14\\)"
    const hits = [...grep(pattern, join(root, "app")), ...grep(pattern, join(root, "components"))]
    expect(hits).toEqual([])
  })

  // Guard the guard: an empty walk makes the assertion above vacuously true.
  it("scans directories that actually lift controls above the tab bar", () => {
    const root = join(__dirname, "..", "..")
    const hits = [
      ...grep("COMPACT_ABOVE_TAB_BAR_BOTTOM", join(root, "app")),
      ...grep("COMPACT_ABOVE_TAB_BAR_BOTTOM", join(root, "components")),
    ]
    expect(hits.length).toBeGreaterThan(1)
  })
})

/** `git grep -l`, returning [] rather than throwing on "no matches" (exit 1). */
function grep(pattern: string, dir: string): string[] {
  try {
    const out = execFileSync("git", ["grep", "-l", "-E", pattern, "--", dir], {
      encoding: "utf8",
    })
    return out.split("\n").filter(Boolean)
  } catch {
    return []
  }
}
