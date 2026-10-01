import { render } from "@testing-library/react"

// Capture what messages/locale the gate feeds NextIntlClientProvider. The
// array name is `mock`-prefixed so babel-plugin-jest-hoist allows the factory
// to reference it.
const mockProviderCalls: Array<{
  locale: string
  messages: Record<string, unknown>
  timeZone?: string
}> = []
jest.mock("next-intl", () => ({
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
    timeZone?: string
    children: React.ReactNode
  }) => {
    mockProviderCalls.push({
      locale: props.locale,
      messages: props.messages,
      timeZone: props.timeZone,
    })
    return props.children
  },
}))

let mockLocale = "en"
jest.mock("@/hooks/ui/use-app-locale", () => ({
  useAppLocaleState: () => ({ locale: mockLocale, ready: true }),
}))

let mockSettingsState: {
  settings?: { language?: string; profile?: { timezone?: string } }
  loaded: boolean
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(mockSettingsState),
}))

jest.mock("@/lib/i18n/plugin-i18n-registry", () => ({
  getMergedPluginMessages: jest.fn(() => ({})),
  getPluginI18nSnapshot: jest.fn(() => 0),
  subscribeToPluginI18n: jest.fn(() => () => {}),
  inflateFlatKeys: (flat: Record<string, string>) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(flat)) {
      const parts = key.split(".")
      let cursor = out as Record<string, unknown>
      for (let i = 0; i < parts.length - 1; i++) {
        cursor[parts[i]] = (cursor[parts[i]] as Record<string, unknown>) ?? {}
        cursor = cursor[parts[i]] as Record<string, unknown>
      }
      cursor[parts[parts.length - 1]] = value
    }
    return out
  },
}))

import { LocaleGate } from "./locale-gate"
import { defaultMessages, startupMessages } from "@/i18n/messages"
import { getMergedPluginMessages } from "@/lib/i18n/plugin-i18n-registry"

const getMergedMock = getMergedPluginMessages as jest.Mock

function latest() {
  const call = mockProviderCalls.at(-1)
  if (!call) throw new Error("NextIntlClientProvider was never rendered")
  return call
}

beforeEach(() => {
  mockProviderCalls.length = 0
  mockSettingsState = { settings: { language: "en" }, loaded: true }
  mockLocale = "en"
  getMergedMock.mockReset().mockReturnValue({})
})

describe("LocaleGate", () => {
  it("renders the eager default bundle for the default locale without loading a chunk", () => {
    mockSettingsState = { settings: { language: "en" }, loaded: true }
    render(<LocaleGate>child</LocaleGate>)
    expect(latest().locale).toBe("en")
    expect(latest().messages).toEqual(defaultMessages)
  })

  it("pins to the default locale until settings hydrate", () => {
    mockSettingsState = { settings: undefined, loaded: false }
    render(<LocaleGate>child</LocaleGate>)
    expect(latest().locale).toBe("en")
    expect(latest().messages).toEqual(defaultMessages)
  })

  it("renders Chinese startup messages immediately without loading a full catalog", () => {
    mockLocale = "zh-CN"
    render(<LocaleGate>child</LocaleGate>)
    expect(latest().locale).toBe("zh-CN")
    expect(latest().messages).toEqual(startupMessages["zh-CN"])
    expect(latest().messages).not.toHaveProperty("projectEnvironment")
  })

  it("merges enabled plugins' messages onto the host bundle", () => {
    mockSettingsState = { settings: { language: "en" }, loaded: true }
    getMergedMock.mockReturnValue({ en: { "pluginNs.greeting": "Hello from plugin" } })

    render(<LocaleGate>child</LocaleGate>)

    const messages = latest().messages as { pluginNs?: { greeting?: string }; common?: unknown }
    expect(messages.pluginNs).toEqual({ greeting: "Hello from plugin" })
    // Host namespaces are preserved alongside the plugin contribution.
    expect(messages.common).toBe((defaultMessages as { common: unknown }).common)
  })

  describe("time zone", () => {
    it("formats in UTC until settings hydrate, so the static render is reproducible", () => {
      mockSettingsState = { settings: undefined, loaded: false }
      render(<LocaleGate>child</LocaleGate>)
      expect(latest().timeZone).toBe("UTC")
    })

    it("formats in the device zone once hydrated — not UTC", () => {
      // Pinned to UTC, a conversation stamped 14:32 in Shanghai read 06:32.
      mockSettingsState = { settings: { language: "en" }, loaded: true }
      render(<LocaleGate>child</LocaleGate>)
      expect(latest().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    })

    it("prefers the profile's own zone", () => {
      mockSettingsState = {
        settings: { language: "en", profile: { timezone: "Asia/Tokyo" } },
        loaded: true,
      }
      render(<LocaleGate>child</LocaleGate>)
      expect(latest().timeZone).toBe("Asia/Tokyo")
    })

    it("falls back to the device zone when the profile names one the runtime rejects", () => {
      // An unknown zone makes every `Intl.DateTimeFormat` throw — it must not
      // take every formatted date in the app with it.
      mockSettingsState = {
        settings: { language: "en", profile: { timezone: "Mars/Olympus_Mons" } },
        loaded: true,
      }
      render(<LocaleGate>child</LocaleGate>)
      expect(latest().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    })
  })
})
