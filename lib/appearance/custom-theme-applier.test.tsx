/**
 * @jest-environment jsdom
 */
import { act, render, waitFor } from "@testing-library/react"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"

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

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
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
  // Reset the inline style on documentElement to avoid bleed between tests.
  for (const cssVar of CSS_VAR_KEYS) {
    document.documentElement.style.removeProperty(cssVar)
  }
  // Reset the relevant flat-projected fields on the real settings store.
  useSettingsStore.setState({
    activeCustomThemeId: null,
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

    // Now deactivate.
    await act(async () => {
      useSettingsStore.setState({ activeCustomThemeId: null })
    })
    await waitFor(() => {
      expect(html.style.getPropertyValue("--background")).toBe("")
    })
    for (const cssVar of CSS_VAR_KEYS) {
      expect(html.style.getPropertyValue(cssVar)).toBe("")
    }
    result?.unmount()
  })
})
