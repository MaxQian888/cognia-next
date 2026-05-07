/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"
import { __resetThemeRegistryForTesting, registerPluginTheme } from "@/lib/theme/theme-registry"

const setTheme = jest.fn()
jest.mock("next-themes", () => ({ useTheme: () => ({ setTheme }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string, params?: Record<string, unknown>) => {
    if (params && typeof params.name === "string") return `${k}:${params.name}`
    return k
  },
}))

const routerReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(""),
}))

// VscodeImportDialog reaches deep into client components via dynamic import
// of @tauri-apps/plugin-fs at runtime — stub it out at module load.
jest.mock("../vscode-import-dialog", () => ({
  VscodeImportDialog: () => null,
}))

const save = jest.fn()
const setActiveCustom = jest.fn()
const createCustomTheme = jest.fn(() => "ct_new")
const deleteCustomTheme = jest.fn()
const removeImportedTheme = jest.fn()
const storeState: { settings: Partial<AppSettings>; activeCustomThemeId: string | null } = {
  settings: {},
  activeCustomThemeId: null,
}

const buildState = () => ({
  settings: storeState.settings,
  activeCustomThemeId: storeState.activeCustomThemeId,
  save,
  setActiveCustomTheme: setActiveCustom,
  createCustomTheme,
  deleteCustomTheme,
  removeImportedTheme,
})

jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    jest.fn((selector: (s: unknown) => unknown) => selector(buildState())),
    { getState: () => buildState() }
  ),
}))

import { ThemeTab } from "./theme-tab"

beforeEach(() => {
  setTheme.mockClear()
  save.mockClear()
  setActiveCustom.mockClear()
  createCustomTheme.mockClear()
  deleteCustomTheme.mockClear()
  removeImportedTheme.mockClear()
  routerReplace.mockClear()
  createCustomTheme.mockReturnValue("ct_new")
  storeState.settings = { theme: "system", colorTheme: "default", activeCustomThemeId: null }
  storeState.activeCustomThemeId = null
  __resetThemeRegistryForTesting()
})

describe("ThemeTab", () => {
  it("renders the three theme radios", () => {
    render(<ThemeTab />)
    expect(screen.getByLabelText("theme.light")).toBeInTheDocument()
    expect(screen.getByLabelText("theme.dark")).toBeInTheDocument()
    expect(screen.getByLabelText("theme.system")).toBeInTheDocument()
  })

  it("saves and pushes the next-themes setter on theme change", () => {
    render(<ThemeTab />)
    fireEvent.click(screen.getByLabelText("theme.dark"))
    expect(setTheme).toHaveBeenCalledWith("dark")
    expect(save).toHaveBeenCalledWith({ theme: "dark" })
  })

  it("renders one button per color preset and marks the active one", () => {
    storeState.settings = { theme: "system", colorTheme: "ocean", activeCustomThemeId: null }
    render(<ThemeTab />)
    const ocean = screen.getByRole("button", { name: /colorPresets.ocean/ })
    expect(ocean.getAttribute("aria-pressed")).toBe("true")
    const forest = screen.getByRole("button", { name: /colorPresets.forest/ })
    expect(forest.getAttribute("aria-pressed")).toBe("false")
  })

  it("saves the chosen preset and clears the active custom when one is set", () => {
    storeState.settings = {
      theme: "system",
      colorTheme: "default",
      activeCustomThemeId: "custom-1",
    }
    render(<ThemeTab />)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /colorPresets.forest/ }))
    })
    expect(setActiveCustom).toHaveBeenCalledWith(null)
    expect(save).toHaveBeenCalledWith({ colorTheme: "forest" })
  })

  it("renders all 4 built-in VSCode presets in the unified grid", () => {
    render(<ThemeTab />)
    expect(screen.getByText("Dracula")).toBeInTheDocument()
    expect(screen.getByText("One Dark Pro")).toBeInTheDocument()
    expect(screen.getByText("Tokyo Night Dark")).toBeInTheDocument()
    expect(screen.getByText("GitHub Light Default")).toBeInTheDocument()
  })

  it("clicking a built-in preset clones it as a persistent CustomTheme and activates it", () => {
    render(<ThemeTab />)
    act(() => {
      fireEvent.click(screen.getByText("Dracula"))
    })
    expect(createCustomTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Dracula",
        baseVariant: "dark",
        sourceBuiltinName: "Dracula",
      })
    )
    expect(setActiveCustom).toHaveBeenCalledWith("ct_new")
  })

  it("re-clicking the same built-in card reuses the existing clone instead of creating another", () => {
    storeState.settings = {
      theme: "system",
      colorTheme: "default",
      activeCustomThemeId: null,
      customThemes: [{ id: "ct-existing", name: "Dracula", sourceBuiltinName: "Dracula" }],
    }
    storeState.activeCustomThemeId = null
    render(<ThemeTab />)
    act(() => {
      fireEvent.click(screen.getByText("Dracula"))
    })
    // The clone already exists — we reuse its id and skip createCustomTheme
    // so repeated clicks on the same card don't spawn duplicate rows.
    expect(createCustomTheme).not.toHaveBeenCalled()
    expect(setActiveCustom).toHaveBeenCalledWith("ct-existing")
  })

  it("treats the built-in card as active when an existing clone is the activeCustomTheme", () => {
    storeState.settings = {
      theme: "system",
      colorTheme: "default",
      activeCustomThemeId: "ct-existing",
      customThemes: [{ id: "ct-existing", name: "Dracula", sourceBuiltinName: "Dracula" }],
    }
    storeState.activeCustomThemeId = "ct-existing"
    render(<ThemeTab />)
    // The Dracula card now shows as active (active label appears next to
    // the name in the same DOM node).
    const draculaCard = screen.getByText(/Dracula/i).closest("button")
    expect(draculaCard?.getAttribute("aria-pressed")).toBe("true")
  })

  it("merges plugin themes registered before render into the grid", () => {
    registerPluginTheme({
      id: "p.violet",
      name: "Violet Glow",
      variables: {},
      source: "plugin",
      pluginId: "p",
      pluginName: "Plugin P",
      colors: {
        background: "#111",
        foreground: "#eee",
        primary: "#7c3aed",
        primaryForeground: "#fff",
        secondary: "#222",
        secondaryForeground: "#eee",
        accent: "#22c55e",
        accentForeground: "#fff",
        muted: "#333",
        mutedForeground: "#aaa",
        card: "#111",
        cardForeground: "#eee",
        popover: "#111",
        popoverForeground: "#eee",
        input: "#222",
        border: "#333",
        ring: "#7c3aed",
        destructive: "#dc2626",
        destructiveForeground: "#fff",
        sidebar: "#111",
        sidebarForeground: "#eee",
        sidebarPrimary: "#7c3aed",
        sidebarBorder: "#333",
        sidebarPrimaryForeground: "#fff",
        sidebarAccent: "#222",
        sidebarAccentForeground: "#eee",
        sidebarRing: "#7c3aed",
      },
      isDark: true,
    })
    render(<ThemeTab />)
    expect(screen.getByText("Violet Glow")).toBeInTheDocument()
    // Source badge text comes through the mocked `t()` with `params.name`.
    expect(screen.getByText("fromPlugin:Plugin P")).toBeInTheDocument()
  })

  it("re-renders when a plugin theme is registered after mount (subscribe wiring)", () => {
    render(<ThemeTab />)
    expect(screen.queryByText("Late Theme")).not.toBeInTheDocument()
    act(() => {
      registerPluginTheme({
        id: "p.late",
        name: "Late Theme",
        variables: {},
        source: "plugin",
        pluginId: "p",
        pluginName: "Plugin P",
        colors: {
          background: "#000",
          foreground: "#fff",
          primary: "#fff",
        } as never,
        isDark: true,
      })
    })
    expect(screen.getByText("Late Theme")).toBeInTheDocument()
  })

  it("filters by name via the search input", () => {
    render(<ThemeTab />)
    const input = screen.getByPlaceholderText("vscode.search.placeholder")
    act(() => {
      fireEvent.change(input, { target: { value: "Dracula" } })
    })
    expect(screen.getByText("Dracula")).toBeInTheDocument()
    expect(screen.queryByText("One Dark Pro")).not.toBeInTheDocument()
  })

  it("filters by light/dark toggle", () => {
    render(<ThemeTab />)
    // Initial: all 4 visible.
    expect(screen.getByText("GitHub Light Default")).toBeInTheDocument()
    expect(screen.getByText("Dracula")).toBeInTheDocument()
    // Switch to "light" — only the GitHub Light preset remains.
    act(() => {
      fireEvent.click(screen.getByText("vscode.filter.light"))
    })
    expect(screen.getByText("GitHub Light Default")).toBeInTheDocument()
    expect(screen.queryByText("Dracula")).not.toBeInTheDocument()
  })
})
