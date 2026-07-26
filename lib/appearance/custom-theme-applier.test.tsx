/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {},
  }),
  saveSettings: jest.fn(),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
}))

jest.mock("@/lib/tts/keyring", () => ({
  loadAllProviderKeys: jest.fn().mockResolvedValue({}),
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
}))

let mockResolvedTheme: string | undefined = "dark"
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}))

import { useSettingsStore } from "@/stores/settings"
import { CustomThemeApplier } from "./custom-theme-applier"
import { CSS_VAR_KEYS } from "./css-var"

function buildTokens(overrides: Partial<ThemeColors> = {}): ThemeColors {
  return {
    background: "#0b0b0b",
    foreground: "#fafafa",
    primary: "#ff00ff",
    primaryForeground: "#000000",
    secondary: "#222",
    secondaryForeground: "#fff",
    accent: "#ff8800",
    accentForeground: "#000",
    muted: "#333",
    mutedForeground: "#bbb",
    card: "#111",
    cardForeground: "#fff",
    popover: "#0f0f0f",
    popoverForeground: "#fff",
    input: "#1a1a1a",
    border: "#222",
    ring: "#ff00ff",
    destructive: "#ff4444",
    destructiveForeground: "#fff",
    sidebar: "#111",
    sidebarForeground: "#fff",
    sidebarPrimary: "#ff00ff",
    sidebarPrimaryForeground: "#000",
    sidebarAccent: "#333",
    sidebarAccentForeground: "#fff",
    sidebarBorder: "#222",
    sidebarRing: "#ff00ff",
    ...overrides,
  } as ThemeColors
}

function makeCustomTheme(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return {
    id: "ct-1",
    name: "Test custom theme",
    isDark: true,
    colors: buildTokens(),
    ...overrides,
  }
}

beforeEach(() => {
  mockResolvedTheme = "dark"
  // Reset the inline style on documentElement to avoid bleed between tests.
  for (const cssVar of CSS_VAR_KEYS) {
    document.documentElement.style.removeProperty(cssVar)
  }
  // Reset the relevant flat-projected fields on the real settings store.
  useSettingsStore.setState({
    activeCustomThemeId: null,
    activePluginThemeId: null,
    customThemes: [],
    colorTheme: "default",
  })
})

describe("CustomThemeApplier", () => {
  it("does not write any inline CSS vars when no custom theme is active", async () => {
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    for (const cssVar of CSS_VAR_KEYS) {
      expect(html.style.getPropertyValue(cssVar)).toBe("")
    }
  })

  it("clears the boot-script shell snapshot for the default theme (no cross-switch bleed)", async () => {
    const html = document.documentElement
    // Simulate the pre-hydration boot script having painted the dark shell
    // snapshot inline. For the default preset these must be dropped so the
    // globals.css :root/.dark rules govern and a theme switch is pure-CSS —
    // otherwise the stale dark background bleeds into light mode.
    html.style.setProperty("--background", "#0b1220")
    html.style.setProperty("--foreground", "#f1f5f9")
    html.style.setProperty("--primary", "#60a5fa")
    html.style.setProperty("--accent", "#60a5fa")
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("")
    })
    expect(html.style.getPropertyValue("--foreground")).toBe("")
    expect(html.style.getPropertyValue("--primary")).toBe("")
    expect(html.style.getPropertyValue("--accent")).toBe("")
  })

  it("writes 27 CSS variables on <html> with matching values when a custom theme is active", async () => {
    const theme = makeCustomTheme()
    useSettingsStore.setState({
      activeCustomThemeId: theme.id,
      customThemes: [theme],
      colorTheme: "default",
    })
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--primary")).toBe("#ff00ff")
    })
    expect(html.style.getPropertyValue("--background")).toBe("#0b0b0b")
    expect(html.style.getPropertyValue("--primary-foreground")).toBe("#000000")
    expect(html.style.getPropertyValue("--sidebar-primary")).toBe("#ff00ff")
    expect(html.style.getPropertyValue("--sidebar-primary-foreground")).toBe("#000")

    // Every key in the canonical list should be set to a non-empty value.
    let written = 0
    for (const cssVar of CSS_VAR_KEYS) {
      if (html.style.getPropertyValue(cssVar) !== "") written++
    }
    expect(written).toBe(CSS_VAR_KEYS.length)
  })

  it("clears previously-injected vars when the custom theme is deactivated", async () => {
    const theme = makeCustomTheme()
    useSettingsStore.setState({
      activeCustomThemeId: theme.id,
      customThemes: [theme],
      colorTheme: "default",
    })
    let result: ReturnType<typeof render> | undefined
    await act(async () => {
      result = render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("#0b0b0b")
    })

    // Spy on removeProperty BEFORE deactivation so the assertions prove cleanup
    // actually ran (rather than relying on beforeEach's pre-emptive wipe).
    const removeSpy = jest.spyOn(html.style, "removeProperty")

    // Now deactivate.
    await act(async () => {
      useSettingsStore.setState({ activeCustomThemeId: null })
    })
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalled()
    })
    for (const cssVar of CSS_VAR_KEYS) {
      expect(removeSpy).toHaveBeenCalledWith(cssVar)
      expect(html.style.getPropertyValue(cssVar)).toBe("")
    }
    removeSpy.mockRestore()
    result?.unmount()
  })

  it("applies a cloned theme's extra cssVars after the structured tokens", async () => {
    const theme = makeCustomTheme({
      id: "ct-css",
      cssVars: { "--custom-glow": "#ff00ff", "--radius-plugin": "1rem" },
    })
    useSettingsStore.setState({
      activeCustomThemeId: theme.id,
      customThemes: [theme],
      colorTheme: "default",
    })
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--custom-glow")).toBe("#ff00ff")
    })
    expect(html.style.getPropertyValue("--radius-plugin")).toBe("1rem")
    // Structured tokens still applied alongside the extras.
    expect(html.style.getPropertyValue("--primary")).toBe("#ff00ff")
  })

  it("yields inline vars while a plugin theme is active (PluginThemeApplier owns the cascade)", async () => {
    const theme = makeCustomTheme()
    useSettingsStore.setState({
      activeCustomThemeId: theme.id,
      customThemes: [theme],
      colorTheme: "default",
    })
    let result: ReturnType<typeof render> | undefined
    await act(async () => {
      result = render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("#0b0b0b")
    })

    // Activate a plugin theme: CustomThemeApplier must clear its inline vars so
    // the <style data-plugin-theme> block (inline > stylesheet) is not shadowed.
    await act(async () => {
      useSettingsStore.setState({ activePluginThemeId: "demo.neon", activeCustomThemeId: null })
    })
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("")
    })
    for (const cssVar of CSS_VAR_KEYS) {
      expect(html.style.getPropertyValue(cssVar)).toBe("")
    }
    result?.unmount()
  })

  it("does not call removeProperty when no custom theme was ever active", async () => {
    // Default state from beforeEach: no active custom theme.
    const removeSpy = jest.spyOn(document.documentElement.style, "removeProperty")
    let result: ReturnType<typeof render> | undefined
    await act(async () => {
      result = render(<CustomThemeApplier />)
    })
    // Toggle a non-custom-theme dependency to force the effect to re-run while
    // still in the !isCustom && !lastApplied.current branch.
    await act(async () => {
      useSettingsStore.setState({ colorTheme: "ocean" })
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(removeSpy).not.toHaveBeenCalled()
    removeSpy.mockRestore()
    result?.unmount()
  })
})

describe("CustomThemeApplier — a11y layers", () => {
  const setA11y = (patch: { colorblindMode?: string; highContrast?: string }) => {
    useSettingsStore.setState({
      settings: {
        ...(useSettingsStore.getState().settings ?? {}),
        a11y: { wcagTarget: "AA", enforcement: "warn+fix", highContrast: "off", ...patch },
      },
    } as never)
  }

  it("writes the categorical colorblind vars alongside the tokens", async () => {
    // These live outside ThemeColors, so they are written by a separate pass that
    // nothing else in this suite reaches.
    setA11y({ colorblindMode: "deuter" })
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--chart-1")).not.toBe("")
    })
  })

  it("clears the colorblind vars again when the mode is turned off", async () => {
    setA11y({ colorblindMode: "deuter" })
    const { rerender } = render(<CustomThemeApplier />)
    const html = document.documentElement
    await waitFor(() => expect(html.style.getPropertyValue("--chart-1")).not.toBe(""))

    await act(async () => {
      setA11y({ colorblindMode: "off" })
      rerender(<CustomThemeApplier />)
    })

    await waitFor(() => expect(html.style.getPropertyValue("--chart-1")).toBe(""))
  })

  it("paints the high-contrast palette inline, overriding the default preset", async () => {
    // The default preset normally defers to globals.css; a high-contrast override
    // must force the inline write path instead.
    setA11y({ highContrast: "dark" })
    await act(async () => {
      render(<CustomThemeApplier />)
    })
    const html = document.documentElement
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("oklch(0 0 0)")
    })
    expect(html.style.getPropertyValue("--foreground")).toBe("oklch(1 0 0)")
  })

  it("stands down and clears everything when a plugin theme takes over", async () => {
    // Inline custom properties out-specify the plugin theme's stylesheet block, so
    // both the tokens and the extra vars have to be dropped — including the
    // colorblind ones, which have their own cleanup path.
    setA11y({ colorblindMode: "deuter" })
    // A cloned theme so the extra `cssVars` cleanup path is exercised too.
    const theme = makeCustomTheme({ cssVars: { "--custom-x": "#123456" } })
    useSettingsStore.setState({ activeCustomThemeId: theme.id, customThemes: [theme] })
    const { rerender } = render(<CustomThemeApplier />)
    const html = document.documentElement
    await waitFor(() => expect(html.style.getPropertyValue("--primary")).toBe("#ff00ff"))
    await waitFor(() => expect(html.style.getPropertyValue("--chart-1")).not.toBe(""))
    expect(html.style.getPropertyValue("--custom-x")).toBe("#123456")

    await act(async () => {
      useSettingsStore.setState({ activePluginThemeId: "plugin-theme-1" })
      rerender(<CustomThemeApplier />)
    })

    await waitFor(() => expect(html.style.getPropertyValue("--primary")).toBe(""))
    expect(html.style.getPropertyValue("--chart-1")).toBe("")
    expect(html.style.getPropertyValue("--custom-x")).toBe("")
  })

  it("clears a cloned theme's extra cssVars when it is swapped for a plain one", async () => {
    const cloned = makeCustomTheme({ id: "cloned", cssVars: { "--custom-x": "#123456" } })
    const plain = makeCustomTheme({ id: "plain" })
    useSettingsStore.setState({
      activeCustomThemeId: cloned.id,
      customThemes: [cloned, plain],
    })
    const { rerender } = render(<CustomThemeApplier />)
    const html = document.documentElement
    await waitFor(() => expect(html.style.getPropertyValue("--custom-x")).toBe("#123456"))

    await act(async () => {
      useSettingsStore.setState({ activeCustomThemeId: plain.id })
      rerender(<CustomThemeApplier />)
    })

    await waitFor(() => expect(html.style.getPropertyValue("--custom-x")).toBe(""))
  })
})

it("drops a cloned theme's cssVars when falling back to the default preset", async () => {
  // The default preset short-circuits to the globals.css rules, so it has its own
  // cleanup path for the extra vars a cloned theme had written.
  const cloned = makeCustomTheme({ id: "cloned2", cssVars: { "--custom-y": "#abcdef" } })
  useSettingsStore.setState({
    activeCustomThemeId: cloned.id,
    customThemes: [cloned],
    // The short-circuit only applies with no a11y extras in play, and an earlier
    // test in this file leaves colorblind mode on.
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      a11y: {
        wcagTarget: "AA",
        enforcement: "warn+fix",
        highContrast: "off",
        colorblindMode: "off",
      },
    },
  } as never)
  const { rerender } = render(<CustomThemeApplier />)
  const html = document.documentElement
  await waitFor(() => expect(html.style.getPropertyValue("--custom-y")).toBe("#abcdef"))

  await act(async () => {
    useSettingsStore.setState({ activeCustomThemeId: null })
    rerender(<CustomThemeApplier />)
  })

  await waitFor(() => expect(html.style.getPropertyValue("--custom-y")).toBe(""))
  expect(html.style.getPropertyValue("--primary")).toBe("")
})

it("writes nothing while next-themes is still hydrating", async () => {
  // Painting on an undefined resolved theme would flash the wrong variant; the
  // effect re-runs once it settles.
  mockResolvedTheme = undefined
  const theme = makeCustomTheme()
  useSettingsStore.setState({ activeCustomThemeId: theme.id, customThemes: [theme] })
  await act(async () => {
    render(<CustomThemeApplier />)
  })

  expect(document.documentElement.style.getPropertyValue("--primary")).toBe("")
})
