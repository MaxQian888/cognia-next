/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"
import type { CustomTheme } from "@/types/plugin/plugin-extended"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

const createCustomTheme = jest.fn().mockReturnValue("ct-new")
const updateCustomTheme = jest.fn()
const deleteCustomTheme = jest.fn()
const setActiveCustomTheme = jest.fn()
const storeState: { settings: Partial<AppSettings> } = { settings: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      settings: storeState.settings,
      createCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
      setActiveCustomTheme,
    })
  ),
}))

import { CustomThemeTab } from "./custom-theme-tab"

const sampleTheme = (id: string, overrides: Partial<CustomTheme> = {}): CustomTheme => ({
  id,
  name: `Theme ${id}`,
  colors: { background: "#101010", foreground: "#ffffff" },
  isDark: true,
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  storeState.settings = { customThemes: [], activeCustomThemeId: null }
})

describe("CustomThemeTab", () => {
  it("disables save until a name is entered", () => {
    render(<CustomThemeTab />)
    const save = screen.getByRole("button", { name: /saveButton/ })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "My Theme" },
    })
    expect(save).not.toBeDisabled()
  })

  it("creates a new theme via createCustomTheme", () => {
    render(<CustomThemeTab />)
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "Mine" },
    })
    fireEvent.click(screen.getByRole("button", { name: /saveButton/ }))
    expect(createCustomTheme).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mine", isDark: true })
    )
  })

  it("renders the saved themes list and switches the draft on click", () => {
    storeState.settings = {
      customThemes: [sampleTheme("a"), sampleTheme("b", { name: "Beta" })],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    expect(screen.getByText("Theme a")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })

  it("activates and deactivates a theme", () => {
    storeState.settings = {
      customThemes: [sampleTheme("ct-1")],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    fireEvent.click(screen.getByText("Theme ct-1"))
    fireEvent.click(screen.getByRole("button", { name: /activateButton/ }))
    expect(setActiveCustomTheme).toHaveBeenCalledWith("ct-1")
  })

  it("deletes the active draft theme", () => {
    storeState.settings = {
      customThemes: [sampleTheme("ct-2")],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    fireEvent.click(screen.getByText("Theme ct-2"))
    fireEvent.click(screen.getByRole("button", { name: /deleteButton/ }))
    expect(deleteCustomTheme).toHaveBeenCalledWith("ct-2")
  })

  it("renders without infinite re-renders when customThemes is undefined", () => {
    storeState.settings = {}
    expect(() => render(<CustomThemeTab />)).not.toThrow()
    expect(screen.getByPlaceholderText("namePlaceholder")).toBeInTheDocument()
  })

  it("toggles light/dark draft", () => {
    render(<CustomThemeTab />)
    const sw = screen.getByLabelText("darkLabel")
    fireEvent.click(sw)
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "Light" },
    })
    fireEvent.click(screen.getByRole("button", { name: /saveButton/ }))
    expect(createCustomTheme).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Light", isDark: false })
    )
  })
})
