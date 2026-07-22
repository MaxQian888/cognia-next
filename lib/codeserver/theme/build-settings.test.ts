import { DEFAULT_FALLBACKS, VSCODE_COLOR_MAP } from "@/lib/appearance/vscode-theme/token-mapping"
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

describe("buildCodeServerColorCustomizations", () => {
  it("emits every VS Code key the shared token map knows about", () => {
    const customizations = buildCodeServerColorCustomizations(dark(), "dark")

    const expected = new Set(Object.values(VSCODE_COLOR_MAP).flat())
    expect(new Set(Object.keys(customizations))).toEqual(expected)
    for (const value of Object.values(customizations)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it("gives a contested key to the semantically primary token", () => {
    // `editor.background` is listed under background, card AND
    // destructiveForeground; `panel.background` under secondary and card.
    const customizations = buildCodeServerColorCustomizations(
      dark({ background: "#101010", card: "#202020", secondary: "#303030" }),
      "dark"
    )

    expect(customizations["editor.background"]).toBe("#101010")
    expect(customizations["panel.background"]).toBe("#303030")
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
    })
    expect(
      buildCodeServerSettings({ colors: DEFAULT_FALLBACKS.light, variant: "light" })
    ).toMatchObject({ "workbench.colorTheme": "Default Light Modern" })
  })

  it("claims no font keys — the app has no editor-font preference to mirror", () => {
    const settings = buildCodeServerSettings({ colors: dark(), variant: "dark" })
    expect(settings).not.toHaveProperty("editor.fontSize")
    expect(settings).not.toHaveProperty("editor.fontFamily")
  })

  it("declares exactly the keys it can produce", () => {
    const produced = Object.keys(buildCodeServerSettings({ colors: dark(), variant: "dark" }))
    expect(new Set(produced)).toEqual(new Set(CODESERVER_MANAGED_SETTING_KEYS))
  })
})

describe("mergeCodeServerSettings", () => {
  const managed = { "workbench.colorTheme": "Default Dark Modern" }

  it("keeps settings the user made from inside VS Code", () => {
    const existing = JSON.stringify({
      "editor.minimap.enabled": false,
      "workbench.colorTheme": "Monokai",
    })

    const merged = JSON.parse(mergeCodeServerSettings(existing, managed))

    expect(merged["editor.minimap.enabled"]).toBe(false)
    expect(merged["workbench.colorTheme"]).toBe("Default Dark Modern")
  })

  it("tolerates the JSONC that VS Code itself writes", () => {
    const existing = `{
      // set by hand
      "editor.tabSize": 4,
      /* block */
      "files.autoSave": "off"
    }`

    const merged = JSON.parse(mergeCodeServerSettings(existing, managed))

    expect(merged["editor.tabSize"]).toBe(4)
    expect(merged["files.autoSave"]).toBe("off")
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
