import { act, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}))

jest.mock("@/i18n/messages", () => ({
  defaultMessages: { common: { ready: "Ready" } },
  loadMessages: jest.fn(),
}))

jest.mock("@/i18n/config", () => ({ defaultLocale: "en", locales: ["en", "zh-CN"] }))
jest.mock("@/lib/tauri/store", () => ({ getPref: jest.fn() }))

// The overlay reads the same settings slice the full LocaleGate does, so the
// browser and Capacitor shells (where `getPref` is always null) still honour
// the chosen language.
const settingsState: { settings: { language?: string } | null; loaded: boolean } = {
  settings: null,
  loaded: false,
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}))

import { getPref } from "@/lib/tauri/store"
import { loadMessages } from "@/i18n/messages"
import { LightweightLocaleGate } from "./lightweight-locale-gate"

const getPrefMock = getPref as jest.Mock
const loadMessagesMock = loadMessages as jest.Mock

beforeEach(() => {
  getPrefMock.mockReset().mockResolvedValue(null)
  loadMessagesMock.mockReset()
  settingsState.settings = null
  settingsState.loaded = false
})

it("renders the eager locale without loading account or plugin stores", async () => {
  render(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(screen.getByText("overlay")).toBeInTheDocument()
  await waitFor(() => expect(getPrefMock).toHaveBeenCalledWith("appearance.locale"))
  expect(loadMessagesMock).not.toHaveBeenCalled()
})

it("loads a mirrored non-default locale and ignores malformed values", async () => {
  getPrefMock.mockResolvedValueOnce("zh-CN")
  loadMessagesMock.mockResolvedValueOnce({ common: { ready: "就绪" } })
  render(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  await waitFor(() => expect(loadMessagesMock).toHaveBeenCalledWith("zh-CN"))

  getPrefMock.mockResolvedValueOnce("fr")
  await act(async () => {
    render(<LightweightLocaleGate>fallback</LightweightLocaleGate>)
  })
  expect(loadMessagesMock).toHaveBeenCalledTimes(1)
})

it("uses the hydrated settings language where the Tauri pref is unreachable", async () => {
  // `getPref` returns null in any browser, which is exactly the /status case.
  getPrefMock.mockResolvedValue(null)
  settingsState.settings = { language: "zh-CN" }
  settingsState.loaded = true
  loadMessagesMock.mockResolvedValueOnce({ common: { ready: "就绪" } })

  await act(async () => {
    render(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  })
  await waitFor(() => expect(loadMessagesMock).toHaveBeenCalledWith("zh-CN"))
})
