/**
 * Tests for `themes-bridge.ts`. Verifies:
 *   - Inline contributions land in the registry directly.
 *   - `vscodeJsonPath` contributions are read + parsed via the existing
 *     `vscodeThemeToCustomTheme` pipeline.
 *   - Path traversal is rejected at the bridge layer (errors collected,
 *     never thrown).
 *   - JSON errors are collected per-contribution; siblings still register.
 *   - `unregisterPluginThemes` purges only the named plugin's themes.
 *   - The registry's subscribe hook fires on register / unregister so the
 *     UI re-renders on plugin enable / disable.
 */

import { PluginThemesBridge, __resetThemesBridgeForTesting } from "./themes-bridge"
import {
  __resetThemeRegistryForTesting,
  getPluginTheme,
  listPluginThemes,
  registerPluginTheme,
  subscribeThemeRegistry,
} from "@/lib/theme/theme-registry"
import type { PluginManifest } from "@/types/plugin/plugin"

jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
}))

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: {
    manager: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  },
}))

import { readTextFile } from "@/lib/file/file-operations"

const mockReadTextFile = readTextFile as jest.MockedFunction<typeof readTextFile>

const INLINE_COLORS = {
  background: "#fafafa",
  foreground: "#111111",
  primary: "#7c3aed",
  primaryForeground: "#ffffff",
  secondary: "#eeeeee",
  secondaryForeground: "#111111",
  accent: "#22c55e",
  accentForeground: "#ffffff",
  muted: "#f3f3f3",
  mutedForeground: "#555555",
  card: "#ffffff",
  cardForeground: "#111111",
  popover: "#ffffff",
  popoverForeground: "#111111",
  input: "#eeeeee",
  border: "#d4d4d4",
  ring: "#7c3aed",
  destructive: "#dc2626",
  destructiveForeground: "#ffffff",
  sidebar: "#fafafa",
  sidebarForeground: "#111111",
  sidebarPrimary: "#7c3aed",
  sidebarBorder: "#d4d4d4",
  sidebarPrimaryForeground: "#ffffff",
  sidebarAccent: "#eeeeee",
  sidebarAccentForeground: "#111111",
  sidebarRing: "#7c3aed",
}

const DRACULA_JSON = JSON.stringify({
  type: "dark",
  colors: {
    "editor.background": "#282a36",
    "editor.foreground": "#f8f8f2",
    "button.background": "#bd93f9",
    "button.foreground": "#282a36",
  },
})

function manifest(themes: PluginManifest["themes"]): PluginManifest {
  return {
    id: "p",
    name: "Plugin P",
    version: "0.0.1",
    type: "frontend",
    description: "",
    main: "src/index.ts",
    capabilities: ["themes"],
    themes,
  } as PluginManifest
}

beforeEach(() => {
  __resetThemeRegistryForTesting()
  __resetThemesBridgeForTesting()
  mockReadTextFile.mockReset()
})

describe("PluginThemesBridge.registerPluginThemes", () => {
  it("registers an inline contribution under `${pluginId}.${id}` with source: 'plugin'", async () => {
    const bridge = new PluginThemesBridge()
    const result = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "noir", name: "Noir", isDark: true, colors: INLINE_COLORS }]),
      "/plugin/p"
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toEqual([])
    const stored = getPluginTheme("p.noir")
    expect(stored?.name).toBe("Noir")
    expect(stored?.source).toBe("plugin")
    expect(stored?.pluginId).toBe("p")
    expect(stored?.pluginName).toBe("Plugin P")
    expect(stored?.colors?.background).toBe("#fafafa")
    expect(stored?.isDark).toBe(true)
    expect(stored?.variables["--background"]).toBe("#fafafa")
    expect(stored?.variables["--primary-foreground"]).toBe("#ffffff")
  })

  it("reads + parses a vscodeJsonPath contribution using the existing parser", async () => {
    mockReadTextFile.mockResolvedValueOnce(DRACULA_JSON)
    const bridge = new PluginThemesBridge()
    const result = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "drac", name: "Dracula", vscodeJsonPath: "themes/dracula.json" }]),
      "/plugin/p"
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toEqual([])
    expect(mockReadTextFile).toHaveBeenCalledWith("/plugin/p/themes/dracula.json")
    const stored = getPluginTheme("p.drac")
    expect(stored?.name).toBe("Dracula")
    // Background was mapped from `editor.background`.
    expect(stored?.colors?.background).toBe("#282a36")
    expect(stored?.isDark).toBe(true)
  })

  it("rejects vscodeJsonPath containing `..` and collects an error", async () => {
    const bridge = new PluginThemesBridge()
    const result = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "evil", name: "Evil", vscodeJsonPath: "../../etc/passwd" }]),
      "/plugin/p"
    )
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].contributionId).toBe("evil")
    expect(result.errors[0].message).toMatch(/Unsafe vscodeJsonPath/)
    expect(getPluginTheme("p.evil")).toBeUndefined()
    expect(mockReadTextFile).not.toHaveBeenCalled()
  })

  it("rejects absolute paths and drive letters", async () => {
    const bridge = new PluginThemesBridge()
    const r1 = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "abs", name: "Abs", vscodeJsonPath: "/etc/shadow" }]),
      "/plugin/p"
    )
    const r2 = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "drive", name: "Drive", vscodeJsonPath: "C:\\Windows\\Temp\\x.json" }]),
      "/plugin/p"
    )
    expect(r1.errors).toHaveLength(1)
    expect(r2.errors).toHaveLength(1)
  })

  it("collects JSON parse errors without throwing or blocking siblings", async () => {
    mockReadTextFile
      .mockResolvedValueOnce("{ this is not json }")
      .mockResolvedValueOnce(DRACULA_JSON)
    const bridge = new PluginThemesBridge()
    const result = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([
        { id: "broken", name: "Broken", vscodeJsonPath: "themes/broken.json" },
        { id: "ok", name: "OK", vscodeJsonPath: "themes/dracula.json" },
      ]),
      "/plugin/p"
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].contributionId).toBe("broken")
    expect(result.errors[0].message).toMatch(/Invalid JSON/)
    expect(getPluginTheme("p.ok")).toBeDefined()
    expect(getPluginTheme("p.broken")).toBeUndefined()
  })

  it("rejects an inline contribution missing required `colors`", async () => {
    const bridge = new PluginThemesBridge()
    const bad: PluginManifest = manifest([
      // Inline contribution missing `foreground`. The schema is
      // `Record<string, string>` so TS doesn't flag this — the bridge
      // enforces required keys at runtime.
      { id: "x", name: "X", colors: { background: "#000" } },
    ])
    const result = await bridge.registerPluginThemes("p", "Plugin P", bad, "/plugin/p")
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toMatch(/foreground/)
  })

  it("projects a cssVariables contribution onto a full palette and carries cssVars", async () => {
    const bridge = new PluginThemesBridge()
    const result = await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([
        {
          id: "neon",
          name: "Neon",
          isDark: true,
          cssVariables: {
            "--background": "#101014",
            "--primary": "#a855f7",
            "--custom-glow": "#ff00ff",
          },
        },
      ]),
      "/plugin/p"
    )
    expect(result.registered).toBe(1)
    const stored = getPluginTheme("p.neon")
    // The declared overrides land on the structured palette...
    expect(stored?.colors?.background).toBe("#101014")
    expect(stored?.colors?.primary).toBe("#a855f7")
    // ...and every other token is filled from the dark fallback (not the old
    // 2-key `{background, foreground}` fabrication).
    expect(stored?.colors?.foreground).toBeTruthy()
    expect(stored?.colors?.card).toBeTruthy()
    expect(stored?.colors?.sidebar).toBeTruthy()
    // Raw cssVars (including the non-token custom property) are carried verbatim.
    expect(stored?.cssVars?.["--custom-glow"]).toBe("#ff00ff")
    expect(stored?.variables["--custom-glow"]).toBe("#ff00ff")
    expect(stored?.isDark).toBe(true)
  })

  it("drops invalid CSS variable names/values but keeps valid overrides", async () => {
    const bridge = new PluginThemesBridge()
    await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([
        {
          id: "guard",
          name: "Guard",
          cssVariables: {
            "--background": "#fff",
            "not-a-var": "#000",
            "--evil": "red</style>",
          },
        },
      ]),
      "/plugin/p"
    )
    const stored = getPluginTheme("p.guard")
    expect(stored?.cssVars?.["--background"]).toBe("#fff")
    expect(stored?.cssVars?.["not-a-var"]).toBeUndefined()
    expect(stored?.cssVars?.["--evil"]).toBeUndefined()
  })
})

describe("PluginThemesBridge.unregisterPluginThemes", () => {
  it("removes only that plugin's themes", async () => {
    const bridge = new PluginThemesBridge()
    await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "a", name: "A", colors: INLINE_COLORS }]),
      "/plugin/p"
    )
    // Manually register another plugin's theme — bypasses the bridge.
    registerPluginTheme({
      id: "q.b",
      name: "B",
      variables: {},
      source: "plugin",
      pluginId: "q",
    })
    expect(bridge.unregisterPluginThemes("p")).toBe(1)
    expect(getPluginTheme("p.a")).toBeUndefined()
    expect(getPluginTheme("q.b")).toBeDefined()
  })

  it("returns 0 when the plugin has no themes", () => {
    const bridge = new PluginThemesBridge()
    expect(bridge.unregisterPluginThemes("nobody")).toBe(0)
  })
})

describe("subscribe propagation", () => {
  it("notifies registry subscribers on bridge register and unregister", async () => {
    const fn = jest.fn()
    const unsubscribe = subscribeThemeRegistry(fn)
    const bridge = new PluginThemesBridge()
    await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "noir", name: "Noir", colors: INLINE_COLORS }]),
      "/plugin/p"
    )
    expect(fn).toHaveBeenCalled()
    fn.mockClear()
    bridge.unregisterPluginThemes("p")
    expect(fn).toHaveBeenCalled()
    unsubscribe()
  })

  it("integration: registry shows the new theme after registerPluginThemes", async () => {
    const bridge = new PluginThemesBridge()
    await bridge.registerPluginThemes(
      "p",
      "Plugin P",
      manifest([{ id: "noir", name: "Noir", colors: INLINE_COLORS }]),
      "/plugin/p"
    )
    expect(listPluginThemes().map((t) => t.id)).toContain("p.noir")
  })
})
