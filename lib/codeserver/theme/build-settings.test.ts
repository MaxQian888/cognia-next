import { DEFAULT_FALLBACKS } from "@/lib/appearance/vscode-theme/token-mapping"
import { VSCODE_CHROME_KEYS, VSCODE_CHROME_MAP } from "@/lib/codeserver/theme/vscode-chrome-map"
import { DEFAULT_CANVAS_SETTINGS } from "@/types/canvas/settings"
import type { ThemeColors } from "@/types/plugin/plugin"

import {
  CODESERVER_MANAGED_SETTING_KEYS,
  buildCodeServerColorCustomizations,
  buildCodeServerSettings,
  mergeCodeServerSettings,
} from "./build-settings"

const dark = (over: Partial<ThemeColors> = {}): ThemeColors => ({
  ...DEFAULT_FALLBACKS.dark,
  ...over,
})

const editor = DEFAULT_CANVAS_SETTINGS.editor
const accessibility = DEFAULT_CANVAS_SETTINGS.accessibility

describe("buildCodeServerColorCustomizations", () => {
  it("emits every key in the chrome map, one value each", () => {
    const customizations = buildCodeServerColorCustomizations(dark(), "dark")
    expect(new Set(Object.keys(customizations))).toEqual(new Set(VSCODE_CHROME_KEYS))
    for (const value of Object.values(customizations)) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
    }
  })

  it("paints the workbench chrome the importer's reversed table left unstyled", () => {
    // These are the surfaces that used to fall through to stock VS Code grey —
    // the whole reason the pane looked like a different application.
    const customizations = buildCodeServerColorCustomizations(
      dark({ sidebar: "#0a0a0a", background: "#101010", card: "#181818" }),
      "dark"
    )
    expect(customizations["titleBar.activeBackground"]).toBe("#0a0a0a")
    expect(customizations["statusBar.background"]).toBe("#0a0a0a")
    expect(customizations["activityBar.background"]).toBe("#0a0a0a")
    expect(customizations["editor.background"]).toBe("#101010")
    expect(customizations["tab.activeBackground"]).toBe("#101010")
    expect(customizations["terminal.background"]).toBe("#181818")
    expect(customizations["panel.background"]).toBe("#181818")
    for (const key of [
      "menu.background",
      "notifications.background",
      "editorSuggestWidget.background",
      "breadcrumb.background",
      "minimap.background",
      "quickInput.background",
      "keybindingLabel.background",
    ]) {
      expect(customizations[key]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
    }
  })

  it("gives panel.border the border token, not a foreground", () => {
    // Regression: inverting the importer table let `secondaryForeground` claim
    // `panel.border` first, so the app's border color never reached VS Code and
    // panels were outlined in a text color.
    const customizations = buildCodeServerColorCustomizations(
      dark({ border: "#333333", secondaryForeground: "#ffffff" }),
      "dark"
    )
    expect(customizations["panel.border"]).toBe("#333333")
  })

  it("emits a value for every palette slot, including the previously-dropped ones", () => {
    // `input`, `card`, `destructiveForeground`, `sidebarPrimary` and
    // `sidebarPrimaryForeground` produced nothing under the reversed table.
    const customizations = buildCodeServerColorCustomizations(
      dark({
        input: "#1a1a1a",
        card: "#2a2a2a",
        sidebarPrimary: "#3a3a3a",
        sidebarPrimaryForeground: "#4a4a4a",
      }),
      "dark"
    )
    expect(customizations["input.background"]).toBe("#1a1a1a")
    expect(customizations["panel.background"]).toBe("#2a2a2a")
    expect(customizations["activityBarBadge.background"]).toBe("#3a3a3a")
    expect(customizations["activityBarBadge.foreground"]).toBe("#4a4a4a")
  })

  it("composites overlay surfaces with an alpha byte", () => {
    const customizations = buildCodeServerColorCustomizations(dark({ accent: "#8000ff" }), "dark")
    // 0.35 → 0x59. Selection must tint the code underneath, not cover it.
    expect(VSCODE_CHROME_MAP["editor.selectionBackground"].alpha).toBe(0.35)
    expect(customizations["editor.selectionBackground"]).toBe("#8000ff59")
    // Opaque surfaces stay 6-digit.
    expect(customizations["editor.background"]).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it("clamps an out-of-range alpha rather than emitting a malformed color", () => {
    const customizations = buildCodeServerColorCustomizations(dark(), "dark")
    // 0 is used deliberately (a fully transparent line-highlight border).
    expect(customizations["editor.lineHighlightBorder"]).toMatch(/00$/)
  })

  it("converts oklch custom-theme values to hex", () => {
    const customizations = buildCodeServerColorCustomizations(
      dark({ background: "oklch(0 0 0)" }),
      "dark"
    )
    expect(customizations["editor.background"]).toBe("#000000")
  })

  it("falls back to the variant default for an unparseable color", () => {
    const customizations = buildCodeServerColorCustomizations(
      dark({ background: "not-a-color" }),
      "dark"
    )
    expect(customizations["editor.background"]).toBe(DEFAULT_FALLBACKS.dark.background)
  })

  it("falls back per variant when a token is missing entirely", () => {
    const withoutBackground = { ...DEFAULT_FALLBACKS.light, background: undefined }
    const customizations = buildCodeServerColorCustomizations(
      withoutBackground as unknown as ThemeColors,
      "light"
    )
    expect(customizations["editor.background"]).toBe(DEFAULT_FALLBACKS.light.background)
  })
})

describe("buildCodeServerSettings", () => {
  it("inherits syntax colors from the matching base theme", () => {
    expect(buildCodeServerSettings({ colors: dark(), variant: "dark" })).toMatchObject({
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.startupEditor": "none",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    })
    expect(
      buildCodeServerSettings({ colors: DEFAULT_FALLBACKS.light, variant: "light" })
    ).toMatchObject({ "workbench.colorTheme": "Default Light Modern" })
  })

  it("switches to a high-contrast base theme so syntax colors follow the app", () => {
    expect(
      buildCodeServerSettings({ colors: dark(), variant: "dark", highContrast: true })
    ).toMatchObject({ "workbench.colorTheme": "Default High Contrast" })
    expect(
      buildCodeServerSettings({
        colors: DEFAULT_FALLBACKS.light,
        variant: "light",
        highContrast: true,
      })
    ).toMatchObject({ "workbench.colorTheme": "Default High Contrast Light" })
  })

  it("stops VS Code from reacting to the OS theme behind the app's back", () => {
    const settings = buildCodeServerSettings({ colors: dark(), variant: "dark" })
    expect(settings["window.autoDetectColorScheme"]).toBe(false)
    expect(settings["window.autoDetectHighContrast"]).toBe(false)
  })

  it("mirrors the app's editor preferences onto the VS Code equivalents", () => {
    const settings = buildCodeServerSettings({
      colors: dark(),
      variant: "dark",
      editor: { ...editor, fontSize: 17, tabSize: 8, wordWrap: true, minimap: false },
      accessibility,
    })
    expect(settings["editor.fontSize"]).toBe(17)
    expect(settings["editor.fontFamily"]).toBe(editor.fontFamily)
    expect(settings["editor.tabSize"]).toBe(8)
    // Monaco's boolean must become VS Code's enum, not a raw `true`.
    expect(settings["editor.wordWrap"]).toBe("on")
    expect(settings["editor.minimap.enabled"]).toBe(false)
    expect(settings["editor.autoClosingBrackets"]).toBe(
      editor.autoClosingBrackets ? "languageDefined" : "never"
    )
  })

  it("mirrors the editor typography onto the integrated terminal", () => {
    const settings = buildCodeServerSettings({
      colors: dark(),
      variant: "dark",
      editor: { ...editor, fontFamily: "'Iosevka'", fontSize: 15 },
    })
    expect(settings["terminal.integrated.fontFamily"]).toBe("'Iosevka'")
    expect(settings["terminal.integrated.fontSize"]).toBe(15)
  })

  it("lets reduced motion override the editor slice's animation settings", () => {
    const animated = { ...editor, cursorBlinking: "smooth" as const, smoothScrolling: true }
    const calm = buildCodeServerSettings({
      colors: dark(),
      variant: "dark",
      editor: animated,
      motion: { speed: 1, reduce: true },
    })
    expect(calm["workbench.reduceMotion"]).toBe("on")
    expect(calm["editor.cursorBlinking"]).toBe("solid")
    expect(calm["editor.cursorSmoothCaretAnimation"]).toBe("off")
    expect(calm["editor.smoothScrolling"]).toBe(false)
    expect(calm["workbench.list.smoothScrolling"]).toBe(false)
    expect(calm["terminal.integrated.smoothScrolling"]).toBe(false)
    expect(calm["terminal.integrated.cursorBlinking"]).toBe(false)

    const lively = buildCodeServerSettings({ colors: dark(), variant: "dark", editor: animated })
    expect(lively["workbench.reduceMotion"]).toBe("off")
    expect(lively["editor.cursorBlinking"]).toBe("smooth")
    expect(lively["editor.smoothScrolling"]).toBe(true)
  })

  it("honours reduced motion asked for on either slice", () => {
    // Two independent switches ask for the same thing; either must be enough.
    const viaA11y = buildCodeServerSettings({
      colors: dark(),
      variant: "dark",
      editor,
      accessibility: { ...accessibility, reducedMotion: true },
    })
    expect(viaA11y["workbench.reduceMotion"]).toBe("on")
  })

  it("turns screen-reader optimization into accessibilitySupport", () => {
    expect(
      buildCodeServerSettings({
        colors: dark(),
        variant: "dark",
        accessibility: { ...accessibility, screenReaderOptimized: true },
      })["editor.accessibilitySupport"]
    ).toBe("on")
    expect(
      buildCodeServerSettings({ colors: dark(), variant: "dark", accessibility })[
        "editor.accessibilitySupport"
      ]
    ).toBe("auto")
  })

  it("still pins the motion keys when no editor slice is available", () => {
    const settings = buildCodeServerSettings({
      colors: dark(),
      variant: "dark",
      motion: { speed: 1, reduce: true },
    })
    expect(settings["editor.cursorBlinking"]).toBe("solid")
    expect(settings["editor.smoothScrolling"]).toBe(false)
    // Editor-slice-only keys stay absent rather than being invented.
    expect(settings).not.toHaveProperty("editor.fontSize")
  })

  it("silences telemetry and self-update in an embedded pane", () => {
    const settings = buildCodeServerSettings({ colors: dark(), variant: "dark" })
    expect(settings["telemetry.telemetryLevel"]).toBe("off")
    expect(settings["update.mode"]).toBe("none")
  })

  it("never produces a key it has not declared as managed", () => {
    const declared = new Set<string>(CODESERVER_MANAGED_SETTING_KEYS)
    const produced = Object.keys(
      buildCodeServerSettings({
        colors: dark(),
        variant: "dark",
        editor,
        accessibility,
        motion: { speed: 1, reduce: false },
      })
    )
    // Every produced key is declared, so the merge's stale-key sweep covers all
    // of them. (The reverse is not required: some keys only appear with a slice.)
    for (const key of produced) expect(declared.has(key)).toBe(true)
    expect(produced.length).toBe(declared.size)
  })
})

describe("mergeCodeServerSettings", () => {
  const managed = { "workbench.colorTheme": "Default Dark Modern" }

  it("keeps settings the user made from inside VS Code", () => {
    const existing = JSON.stringify({
      "files.autoSave": "afterDelay",
      "git.autofetch": true,
      "workbench.colorTheme": "Monokai",
    })

    const merged = JSON.parse(mergeCodeServerSettings(existing, managed))

    expect(merged["files.autoSave"]).toBe("afterDelay")
    expect(merged["git.autofetch"]).toBe(true)
    expect(merged["workbench.colorTheme"]).toBe("Default Dark Modern")
  })

  it("clears a managed key the current build no longer emits", () => {
    // Otherwise a setting the app used to own would be frozen at its last
    // written value forever, with nothing left to update it.
    const existing = JSON.stringify({ "editor.fontSize": 22, "files.autoSave": "off" })
    const merged = JSON.parse(mergeCodeServerSettings(existing, managed))
    expect(merged).not.toHaveProperty("editor.fontSize")
    expect(merged["files.autoSave"]).toBe("off")
  })

  it("tolerates the JSONC that VS Code itself writes", () => {
    const existing = `{
      // set by hand
      "files.autoSave": "off",
      /* block */
      "git.confirmSync": false
    }`

    const merged = JSON.parse(mergeCodeServerSettings(existing, managed))

    expect(merged["files.autoSave"]).toBe("off")
    expect(merged["git.confirmSync"]).toBe(false)
  })

  it("starts fresh from an empty or corrupt file rather than skipping the sync", () => {
    expect(JSON.parse(mergeCodeServerSettings("", managed))).toEqual(managed)
    expect(JSON.parse(mergeCodeServerSettings("   ", managed))).toEqual(managed)
    expect(JSON.parse(mergeCodeServerSettings("{ broken", managed))).toEqual(managed)
  })

  it("ignores a non-object top level", () => {
    expect(JSON.parse(mergeCodeServerSettings("[1,2]", managed))).toEqual(managed)
  })

  it("writes readable, newline-terminated JSON", () => {
    const out = mergeCodeServerSettings("{}", managed)
    expect(out.endsWith("\n")).toBe(true)
    expect(out).toContain('\n  "workbench.colorTheme"')
  })
})
