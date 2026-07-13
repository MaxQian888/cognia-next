/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {},
  }),
  saveSettings: jest.fn().mockResolvedValue({ id: "singleton" }),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
}))

jest.mock("@/lib/tts/keyring", () => ({
  loadAllProviderKeys: jest.fn().mockResolvedValue({}),
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
}))

import { useSettingsStore } from "@/stores/settings"
import { registerPluginTheme, __resetThemeRegistryForTesting } from "@/lib/theme/theme-registry"
import { PluginThemeApplier, serializePluginThemeCss } from "./plugin-theme-applier"

const STYLE_ID = "cognia-plugin-theme"

function styleEl(): HTMLElement | null {
  return document.getElementById(STYLE_ID)
}

beforeEach(() => {
  __resetThemeRegistryForTesting()
  styleEl()?.remove()
  useSettingsStore.setState({ activePluginThemeId: null, activeCustomThemeId: null })
})

describe("serializePluginThemeCss", () => {
  it("emits a :root block with only valid custom properties", () => {
    const css = serializePluginThemeCss({
      "--background": "oklch(0.16 0.02 275)",
      "--primary": "#a855f7",
    })
    expect(css).toBe(":root{--background: oklch(0.16 0.02 275); --primary: #a855f7;}")
  })

  it("drops non-custom-property names, empty values, and injection attempts", () => {
    const css = serializePluginThemeCss({
      color: "red", // not a custom property
      "--empty": "",
      "--evil": "</style><script>alert(1)</script>",
      "--brace": "red}body{display:none",
      "--ok": "#fff",
    })
    expect(css).toBe(":root{--ok: #fff;}")
  })
})

describe("PluginThemeApplier", () => {
  it("injects no style element when no plugin theme is active", async () => {
    await act(async () => {
      render(<PluginThemeApplier />)
    })
    expect(styleEl()).toBeNull()
  })

  it("injects a <style data-plugin-theme> block carrying the theme's variables", async () => {
    registerPluginTheme({
      id: "demo.neon",
      name: "Neon Noir",
      pluginId: "demo",
      variant: "dark",
      variables: { "--background": "#101014", "--primary": "#a855f7" },
      cssVars: { "--background": "#101014", "--primary": "#a855f7" },
    })
    useSettingsStore.setState({ activePluginThemeId: "demo.neon" })

    await act(async () => {
      render(<PluginThemeApplier />)
    })

    await waitFor(() => expect(styleEl()).not.toBeNull())
    const el = styleEl()!
    expect(el.getAttribute("data-plugin-theme")).toBe("demo")
    expect(el.getAttribute("data-theme-id")).toBe("demo.neon")
    expect(el.textContent).toContain("--background: #101014;")
    expect(el.textContent).toContain("--primary: #a855f7;")
  })

  it("removes the block when the plugin theme is deactivated", async () => {
    registerPluginTheme({
      id: "demo.neon",
      name: "Neon Noir",
      pluginId: "demo",
      variant: "dark",
      variables: { "--background": "#101014" },
      cssVars: { "--background": "#101014" },
    })
    useSettingsStore.setState({ activePluginThemeId: "demo.neon" })

    await act(async () => {
      render(<PluginThemeApplier />)
    })
    await waitFor(() => expect(styleEl()).not.toBeNull())

    await act(async () => {
      useSettingsStore.setState({ activePluginThemeId: null })
    })
    await waitFor(() => expect(styleEl()).toBeNull())
  })

  it("clears a dangling active id and removes the block when the plugin is gone", async () => {
    // activePluginThemeId points at a theme that is NOT registered (plugin
    // disabled / uninstalled). The applier must remove any block and reset the
    // pointer so the preset/custom theme takes over.
    useSettingsStore.setState({ activePluginThemeId: "ghost.theme" })

    await act(async () => {
      render(<PluginThemeApplier />)
    })

    await waitFor(() => {
      expect(useSettingsStore.getState().activePluginThemeId).toBeNull()
    })
    expect(styleEl()).toBeNull()
  })

  it("removes the block on unmount", async () => {
    registerPluginTheme({
      id: "demo.neon",
      name: "Neon Noir",
      pluginId: "demo",
      variant: "dark",
      variables: { "--background": "#101014" },
    })
    useSettingsStore.setState({ activePluginThemeId: "demo.neon" })

    let result: ReturnType<typeof render> | undefined
    await act(async () => {
      result = render(<PluginThemeApplier />)
    })
    await waitFor(() => expect(styleEl()).not.toBeNull())

    await act(async () => {
      result?.unmount()
    })
    expect(styleEl()).toBeNull()
  })
})
