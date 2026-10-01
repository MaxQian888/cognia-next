import { render, screen } from "@testing-library/react"

let mockLocale = "en"
const mockProviders: Array<{
  locale: string
  messages: Record<string, unknown>
  timeZone: string
}> = []
jest.mock("next-intl", () => ({
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
    timeZone: string
    children: React.ReactNode
  }) => {
    mockProviders.push(props)
    return props.children
  },
}))
jest.mock("@/hooks/ui/use-app-locale", () => ({
  useAppLocaleState: () => ({ locale: mockLocale, ready: true }),
}))
const settingsState: { settings: { profile?: { timezone?: string } } | null; loaded: boolean } = {
  settings: null,
  loaded: false,
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}))
import { startupMessages } from "@/i18n/messages"
import { LightweightLocaleGate } from "./lightweight-locale-gate"

beforeEach(() => {
  mockLocale = "en"
  mockProviders.length = 0
  settingsState.settings = null
  settingsState.loaded = false
})

it("leaves settings hydration reachable before a full language pack is requested", () => {
  render(<LightweightLocaleGate>hydrator</LightweightLocaleGate>)
  expect(screen.getByText("hydrator")).toBeInTheDocument()
  expect(mockProviders.at(-1)?.messages).toBe(startupMessages.en)
})

it("switches both locale and startup copy from Chinese back to English", () => {
  mockLocale = "zh-CN"
  const { rerender } = render(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(mockProviders.at(-1)?.messages).toBe(startupMessages["zh-CN"])
  mockLocale = "en"
  rerender(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(mockProviders.at(-1)?.locale).toBe("en")
  expect(mockProviders.at(-1)?.messages).toBe(startupMessages.en)
})

it("formats in UTC until settings load, then follows the profile zone", () => {
  const { rerender } = render(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(mockProviders.at(-1)?.timeZone).toBe("UTC")
  settingsState.loaded = true
  settingsState.settings = { profile: { timezone: "Asia/Tokyo" } }
  rerender(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(mockProviders.at(-1)?.timeZone).toBe("Asia/Tokyo")
  settingsState.settings = { profile: { timezone: "Not/AZone" } }
  rerender(<LightweightLocaleGate>overlay</LightweightLocaleGate>)
  expect(mockProviders.at(-1)?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
})
