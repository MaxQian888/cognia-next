/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"

const setTheme = jest.fn()
jest.mock("next-themes", () => ({ useTheme: () => ({ setTheme }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const save = jest.fn()
const setActiveCustom = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      settings: storeState.settings,
      save,
      setActiveCustomTheme: setActiveCustom,
    })
  ),
}))

import { ThemeTab } from "./theme-tab"

beforeEach(() => {
  setTheme.mockClear()
  save.mockClear()
  setActiveCustom.mockClear()
  storeState.settings = { theme: "system", colorTheme: "default", activeCustomThemeId: null }
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

  it("saves the chosen preset", () => {
    render(<ThemeTab />)
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /colorPresets.ocean/ }))
    })
    expect(save).toHaveBeenCalledWith({ colorTheme: "ocean" })
  })

  it("clears the active custom theme when picking a preset", () => {
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
})
