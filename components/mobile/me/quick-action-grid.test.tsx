/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const themeRef = { value: "system" as "system" | "light" | "dark" }
const setThemeMock = jest.fn((next: string) => {
  themeRef.value = next as typeof themeRef.value
})
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme: setThemeMock }),
}))

const settingsRef: {
  current: { language: "en" | "zh-CN"; mobileComputerUseEnabled?: boolean }
} = { current: { language: "en", mobileComputerUseEnabled: false } }

const setLanguageMock = jest.fn(async (next: "en" | "zh-CN") => {
  settingsRef.current.language = next
})
const saveMock = jest.fn(async (patch: Record<string, unknown>) => {
  if (typeof patch.mobileComputerUseEnabled === "boolean") {
    settingsRef.current.mobileComputerUseEnabled = patch.mobileComputerUseEnabled
  }
})

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      language: "en" | "zh-CN"
      setLanguage: typeof setLanguageMock
      settings: typeof settingsRef.current
      save: typeof saveMock
    }) => unknown
  ) =>
    selector({
      language: settingsRef.current.language,
      setLanguage: setLanguageMock,
      settings: settingsRef.current,
      save: saveMock,
    }),
}))

const selectionFeedbackMock = jest.fn()
jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: () => selectionFeedbackMock(),
}))

jest.mock("@/components/mobile/connection-state-sheets/mobile-server-scan-sheet", () => ({
  MobileServerScanSheet: ({ open }: { open: boolean }) => (
    <div data-testid="scan-sheet-stub" data-open={String(open)} />
  ),
}))

import { QuickActionGrid } from "./quick-action-grid"

beforeEach(() => {
  themeRef.value = "system"
  setThemeMock.mockClear()
  settingsRef.current = { language: "en", mobileComputerUseEnabled: false }
  setLanguageMock.mockClear()
  saveMock.mockClear()
  selectionFeedbackMock.mockClear()
})

describe("<QuickActionGrid />", () => {
  it("renders all four tiles", () => {
    render(<QuickActionGrid />)
    expect(screen.getByTestId("quick-theme-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("quick-language-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("quick-computer-use-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("quick-scan-pair")).toBeInTheDocument()
  })

  it("cycles theme system → light → dark → system", () => {
    const { rerender } = render(<QuickActionGrid />)
    const click = () => fireEvent.click(screen.getByTestId("quick-theme-toggle"))
    click()
    expect(setThemeMock).toHaveBeenLastCalledWith("light")
    themeRef.value = "light"
    rerender(<QuickActionGrid />)
    click()
    expect(setThemeMock).toHaveBeenLastCalledWith("dark")
    themeRef.value = "dark"
    rerender(<QuickActionGrid />)
    click()
    expect(setThemeMock).toHaveBeenLastCalledWith("system")
    expect(selectionFeedbackMock).toHaveBeenCalledTimes(3)
  })

  it("persists the theme through the settings store so a sync tick can't revert it", () => {
    render(<QuickActionGrid />)
    fireEvent.click(screen.getByTestId("quick-theme-toggle"))
    // Both halves must fire: next-themes for instant feedback AND the store
    // write that SettingsSyncProvider re-applies on every settings change.
    expect(setThemeMock).toHaveBeenLastCalledWith("light")
    expect(saveMock).toHaveBeenCalledWith({ theme: "light" })
  })

  it("cycles language en ↔ zh-CN", () => {
    const { rerender } = render(<QuickActionGrid />)
    fireEvent.click(screen.getByTestId("quick-language-toggle"))
    expect(setLanguageMock).toHaveBeenLastCalledWith("zh-CN")
    settingsRef.current.language = "zh-CN"
    rerender(<QuickActionGrid />)
    fireEvent.click(screen.getByTestId("quick-language-toggle"))
    expect(setLanguageMock).toHaveBeenLastCalledWith("en")
  })

  it("toggles mobileComputerUseEnabled when the CU tile is pressed", () => {
    render(<QuickActionGrid />)
    fireEvent.click(screen.getByTestId("quick-computer-use-toggle"))
    expect(saveMock).toHaveBeenCalledWith({ mobileComputerUseEnabled: true })
  })

  it("opens the scan sheet when the scan tile is pressed", () => {
    render(<QuickActionGrid />)
    expect(screen.getByTestId("scan-sheet-stub")).toHaveAttribute("data-open", "false")
    fireEvent.click(screen.getByTestId("quick-scan-pair"))
    expect(screen.getByTestId("scan-sheet-stub")).toHaveAttribute("data-open", "true")
  })

  it("CU tile carries the active state when the flag is on", () => {
    settingsRef.current.mobileComputerUseEnabled = true
    render(<QuickActionGrid />)
    expect(screen.getByTestId("quick-computer-use-toggle").className).toMatch(/border-primary\/60/)
  })
})
