import { THEME_COLOR_KEYS } from "@/lib/appearance/vscode-theme/token-mapping"
import { VSCODE_CHROME_KEYS, VSCODE_CHROME_MAP } from "./vscode-chrome-map"

describe("VSCODE_CHROME_MAP", () => {
  it("only sources from real palette slots", () => {
    const slots = new Set<string>(THEME_COLOR_KEYS)
    for (const [key, source] of Object.entries(VSCODE_CHROME_MAP)) {
      expect(slots.has(source.token)).toBe(true)
      // A typo'd VS Code key is silently ignored by the workbench, so guard the
      // shape. A few keys are top-level (`foreground`, `focusBorder`); the rest
      // are `area.property` or `area.sub.property`. No whitespace either way.
      expect(key).toMatch(/^[A-Za-z]+(\.[A-Za-z0-9]+){0,2}$/)
    }
  })

  it("keeps every alpha inside 0..1", () => {
    for (const [key, source] of Object.entries(VSCODE_CHROME_MAP)) {
      if (source.alpha === undefined) continue
      expect(source.alpha).toBeGreaterThanOrEqual(0)
      expect(source.alpha).toBeLessThanOrEqual(1)
      // Guard against a `255`-style mistake reading as opaque-and-clamped.
      expect(Number.isFinite(source.alpha)).toBe(true)
      expect(key).toBeTruthy()
    }
  })

  it("covers every workbench area the pane actually shows", () => {
    // The failure mode this table exists to prevent is a whole area falling
    // through to stock VS Code grey, so assert per-area presence rather than a
    // key count that would drift on every addition.
    const areas = [
      "titleBar",
      "commandCenter",
      "menu",
      "activityBar",
      "sideBar",
      "editorGroupHeader",
      "tab",
      "editor",
      "editorWidget",
      "editorSuggestWidget",
      "editorHoverWidget",
      "quickInput",
      "list",
      "input",
      "dropdown",
      "button",
      "badge",
      "scrollbarSlider",
      "minimap",
      "panel",
      "terminal",
      "statusBar",
      "notifications",
      "breadcrumb",
      "settings",
      "peekView",
      "diffEditor",
    ]
    for (const area of areas) {
      expect(VSCODE_CHROME_KEYS.some((key) => key.startsWith(`${area}.`))).toBe(true)
    }
  })

  it("paints opaque surfaces opaquely and overlays translucently", () => {
    // Getting this backwards is the difference between "themed" and "unreadable".
    for (const key of [
      "editor.background",
      "sideBar.background",
      "titleBar.activeBackground",
      "statusBar.background",
      "panel.background",
      "terminal.background",
      "tab.activeBackground",
      "menu.background",
      "quickInput.background",
    ]) {
      expect(VSCODE_CHROME_MAP[key].alpha).toBeUndefined()
    }
    for (const key of [
      "editor.selectionBackground",
      "editor.lineHighlightBackground",
      "list.hoverBackground",
      "scrollbarSlider.background",
      "toolbar.hoverBackground",
    ]) {
      expect(VSCODE_CHROME_MAP[key].alpha).toBeLessThan(1)
    }
  })

  it("exposes its keys as a stable list", () => {
    expect(VSCODE_CHROME_KEYS).toEqual(Object.keys(VSCODE_CHROME_MAP))
    expect(new Set(VSCODE_CHROME_KEYS).size).toBe(VSCODE_CHROME_KEYS.length)
  })
})
