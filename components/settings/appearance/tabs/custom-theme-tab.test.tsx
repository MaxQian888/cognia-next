/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { AppSettings } from "@/lib/claude/types"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin-extended"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    return (k: string, vars?: Record<string, unknown>) => {
      if (vars) {
        return `${k}:${JSON.stringify(vars)}`
      }
      return k
    }
  },
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
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

// Both the audit check and the theme-export round-trip want a fully
// populated palette. This builds one with sensible high-contrast defaults
// and lets tests override individual slots to force audit failures.
function buildTokens(overrides: Partial<ThemeColors> = {}): ThemeColors {
  return {
    background: "#ffffff",
    foreground: "#000000",
    primary: "#1d4ed8",
    primaryForeground: "#ffffff",
    secondary: "#475569",
    secondaryForeground: "#ffffff",
    accent: "#1d4ed8",
    accentForeground: "#ffffff",
    muted: "#f1f5f9",
    mutedForeground: "#1f2937",
    card: "#ffffff",
    cardForeground: "#000000",
    popover: "#ffffff",
    popoverForeground: "#000000",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#1d4ed8",
    destructive: "#b91c1c",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#000000",
    sidebarPrimary: "#1d4ed8",
    sidebarPrimaryForeground: "#ffffff",
    sidebarAccent: "#f1f5f9",
    sidebarAccentForeground: "#000000",
    sidebarBorder: "#e2e8f0",
    sidebarRing: "#1d4ed8",
    ...overrides,
  } as ThemeColors
}

const sampleTheme = (id: string, overrides: Partial<CustomTheme> = {}): CustomTheme => ({
  id,
  name: `Theme ${id}`,
  baseVariant: "dark",
  tokens: { light: buildTokens(), dark: buildTokens({ background: "#0b0b0b" }) },
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
    const save = screen.getByRole("button", { name: /^saveButton$/ })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "My Theme" },
    })
    expect(save).not.toBeDisabled()
  })

  it("creates a new theme via createCustomTheme with dual-variant tokens", () => {
    render(<CustomThemeTab />)
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "Mine" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^saveButton$/ }))
    expect(createCustomTheme).toHaveBeenCalledTimes(1)
    const arg = createCustomTheme.mock.calls[0][0]
    expect(arg.name).toBe("Mine")
    expect(arg.baseVariant).toBe("dark")
    // Dual-variant tokens are written directly (closes the Task 7 TODO).
    expect(arg.tokens).toBeDefined()
    expect(arg.tokens.light).toBeDefined()
    expect(arg.tokens.dark).toBeDefined()
    // Legacy fields kept one release for rollback safety.
    expect(arg.isDark).toBe(true)
    expect(arg.colors).toBeDefined()
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
    fireEvent.click(screen.getByRole("button", { name: /^saveButton$/ }))
    expect(createCustomTheme).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Light", isDark: false, baseVariant: "light" })
    )
  })

  it("renders the audit health badge with no failures by default", () => {
    render(<CustomThemeTab />)
    // The default fallback palette is high-contrast, so audit.allPass shows.
    expect(screen.getByText("audit.allPass")).toBeInTheDocument()
    expect(screen.queryByText(/audit\.failuresCount/)).not.toBeInTheDocument()
  })

  it("shows a destructive badge with failure count for a low-contrast palette", () => {
    // Editing an existing theme with grey-on-grey tokens forces the eight
    // critical pairs to fall below WCAG AA.
    const greyTokens = buildTokens({
      background: "#888888",
      foreground: "#999999",
      card: "#888888",
      cardForeground: "#999999",
      popover: "#888888",
      popoverForeground: "#999999",
      primary: "#888888",
      primaryForeground: "#999999",
      destructive: "#888888",
      destructiveForeground: "#999999",
      muted: "#888888",
      mutedForeground: "#999999",
      accent: "#888888",
      accentForeground: "#999999",
      sidebar: "#888888",
      sidebarForeground: "#999999",
    })
    storeState.settings = {
      customThemes: [
        sampleTheme("low", {
          tokens: { light: greyTokens, dark: greyTokens },
        }),
      ],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    fireEvent.click(screen.getByText("Theme low"))
    // The failuresCount badge shows the count + total via the message
    // formatter; our test mock embeds the vars as JSON.
    const failureBadge = screen.getByText(/audit\.failuresCount/)
    expect(failureBadge).toBeInTheDocument()
    expect(failureBadge.textContent).toContain('"count":8')
    expect(failureBadge.textContent).toContain('"total":8')
    // Per-row chips appear next to the flagged tokens.
    expect(screen.getAllByText("audit.lowContrast").length).toBeGreaterThan(0)
  })

  it("export button creates a download for the theme", () => {
    storeState.settings = {
      customThemes: [sampleTheme("ct-x", { name: "Exportable" })],
      activeCustomThemeId: null,
    }
    const createObjectURL = jest.fn().mockReturnValue("blob:fake")
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    })
    const click = jest.fn()
    const realCreate = document.createElement.bind(document)
    const createSpy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        // Use a real anchor element so href/download attribute setters work.
        const a = realCreate("a") as HTMLAnchorElement
        a.click = click
        return a
      }
      return realCreate(tag)
    })

    render(<CustomThemeTab />)
    fireEvent.click(screen.getByRole("button", { name: /actions\.export Exportable/ }))

    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake")
    createSpy.mockRestore()
  })

  it("import button reads the selected file and calls createCustomTheme", async () => {
    render(<CustomThemeTab />)
    const fileInput = screen.getByTestId("custom-theme-import-input") as HTMLInputElement
    const payload = {
      $schema: "https://cognia.dev/schemas/custom-theme/v1.json",
      formatVersion: "v1",
      name: "From File",
      baseVariant: "dark",
      tokens: { light: buildTokens(), dark: buildTokens({ background: "#0b0b0b" }) },
      exportedAt: "2026-05-04T00:00:00.000Z",
    }
    // jsdom's File.prototype.text isn't reliable across versions, so we
    // stub the method directly on the synthetic File instance.
    const file = new File([JSON.stringify(payload)], "from-file.cognia-theme.json", {
      type: "application/json",
    })
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(JSON.stringify(payload)),
    })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(createCustomTheme).toHaveBeenCalledTimes(1))
    const arg = createCustomTheme.mock.calls[0][0]
    expect(arg.name).toBe("From File")
    expect(arg.baseVariant).toBe("dark")
    expect(arg.tokens.dark.background).toBe("#0b0b0b")
    expect(setActiveCustomTheme).toHaveBeenCalledWith("ct-new")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("import shows a toast.error when the JSON is malformed", async () => {
    render(<CustomThemeTab />)
    const fileInput = screen.getByTestId("custom-theme-import-input") as HTMLInputElement
    const file = new File(["not json"], "bad.json", { type: "application/json" })
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve("not json"),
    })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(createCustomTheme).not.toHaveBeenCalled()
  })

  it("save warning dialog opens when audit has failures and Save Anyway commits", async () => {
    const greyTokens = buildTokens({
      background: "#888888",
      foreground: "#999999",
    })
    storeState.settings = {
      customThemes: [
        sampleTheme("low2", {
          name: "Low",
          tokens: { light: greyTokens, dark: greyTokens },
        }),
      ],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    fireEvent.click(screen.getByText("Low"))
    fireEvent.click(screen.getByRole("button", { name: /^updateButton$/ }))
    // Dialog appears.
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText("audit.saveWarningTitle")).toBeInTheDocument()
    // Confirm.
    fireEvent.click(within(dialog).getByRole("button", { name: /audit\.saveAnyway/ }))
    expect(updateCustomTheme).toHaveBeenCalledTimes(1)
  })

  it("save proceeds without dialog when audit is clean", () => {
    render(<CustomThemeTab />)
    fireEvent.change(screen.getByPlaceholderText("namePlaceholder"), {
      target: { value: "Clean" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^saveButton$/ }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(createCustomTheme).toHaveBeenCalledTimes(1)
  })

  it("preserves the existing opposite-variant tokens when saving an existing theme", () => {
    // Both palettes need to be high-contrast so the audit passes and we
    // hit performSave directly (no dialog). Light side has its own
    // primary/background fingerprint we assert wasn't re-derived.
    const lightTokens = buildTokens({
      background: "#fefefe",
      foreground: "#000000",
      primary: "#aaaaaa",
      card: "#fefefe",
      cardForeground: "#000000",
      popover: "#fefefe",
      popoverForeground: "#000000",
      sidebar: "#fefefe",
      sidebarForeground: "#000000",
    })
    const darkTokens = buildTokens({
      background: "#010101",
      foreground: "#ffffff",
      primary: "#bbbbbb",
      primaryForeground: "#000000",
      card: "#010101",
      cardForeground: "#ffffff",
      popover: "#010101",
      popoverForeground: "#ffffff",
      muted: "#1a1a1a",
      mutedForeground: "#eeeeee",
      accent: "#1a1a1a",
      accentForeground: "#ffffff",
      destructive: "#dc2626",
      destructiveForeground: "#ffffff",
      sidebar: "#010101",
      sidebarForeground: "#ffffff",
    })
    storeState.settings = {
      customThemes: [
        sampleTheme("ct-pair", {
          name: "Pair",
          baseVariant: "dark",
          tokens: { light: lightTokens, dark: darkTokens },
        }),
      ],
      activeCustomThemeId: null,
    }
    render(<CustomThemeTab />)
    fireEvent.click(screen.getByText("Pair"))
    fireEvent.click(screen.getByRole("button", { name: /^updateButton$/ }))
    expect(updateCustomTheme).toHaveBeenCalledTimes(1)
    const [, updates] = updateCustomTheme.mock.calls[0]
    // Opposite (light) side preserved verbatim, not re-derived.
    expect(updates.tokens.light.primary).toBe("#aaaaaa")
    expect(updates.tokens.light.background).toBe("#fefefe")
    expect(updates.baseVariant).toBe("dark")
  })
})
