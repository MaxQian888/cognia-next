import { render, act, waitFor } from "@testing-library/react"

// Capture what messages/locale the gate feeds NextIntlClientProvider. The
// array name is `mock`-prefixed so babel-plugin-jest-hoist allows the factory
// to reference it.
const mockProviderCalls: Array<{ locale: string; messages: Record<string, unknown> }> = []
jest.mock("next-intl", () => ({
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
    children: React.ReactNode
  }) => {
    mockProviderCalls.push({ locale: props.locale, messages: props.messages })
    return props.children
  },
}))

jest.mock("@/i18n/messages", () => ({
  // Inlined (not a closed-over const): the factory reads this at invocation
  // time, which runs before top-level const initializers due to import hoisting.
  defaultMessages: { common: { hi: "Hi" } },
  loadMessages: jest.fn(),
}))

jest.mock("@/i18n/config", () => ({ defaultLocale: "en" }))

let mockSettingsState: { settings?: { language?: string }; loaded: boolean }
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
import { defaultMessages, loadMessages } from "@/i18n/messages"
import { getMergedPluginMessages } from "@/lib/i18n/plugin-i18n-registry"

const loadMessagesMock = loadMessages as jest.Mock
const getMergedMock = getMergedPluginMessages as jest.Mock

function latest() {
  const call = mockProviderCalls.at(-1)
  if (!call) throw new Error("NextIntlClientProvider was never rendered")
  return call
}

beforeEach(() => {
  mockProviderCalls.length = 0
  mockSettingsState = { settings: { language: "en" }, loaded: true }
  loadMessagesMock.mockReset()
  getMergedMock.mockReset().mockReturnValue({})
})

describe("LocaleGate", () => {
  it("renders the eager default bundle for the default locale without loading a chunk", () => {
    mockSettingsState = { settings: { language: "en" }, loaded: true }
    render(<LocaleGate>child</LocaleGate>)
    expect(latest().locale).toBe("en")
    expect(latest().messages).toBe(defaultMessages)
    expect(loadMessagesMock).not.toHaveBeenCalled()
  })

  it("pins to the default locale until settings hydrate", () => {
    mockSettingsState = { settings: undefined, loaded: false }
    render(<LocaleGate>child</LocaleGate>)
    expect(latest().locale).toBe("en")
    expect(latest().messages).toBe(defaultMessages)
    expect(loadMessagesMock).not.toHaveBeenCalled()
  })

  it("renders the default bundle as fallback, then swaps to the non-default chunk", async () => {
    mockSettingsState = { settings: { language: "zh-CN" }, loaded: true }
    const zh = { common: { hi: "你好" } }
    let resolveLoad: (value: unknown) => void = () => {}
    loadMessagesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )

    render(<LocaleGate>child</LocaleGate>)

    // Before the chunk resolves: locale is already zh-CN but messages fall back.
    expect(latest().locale).toBe("zh-CN")
    expect(latest().messages).toBe(defaultMessages)
    expect(loadMessagesMock).toHaveBeenCalledWith("zh-CN")

    await act(async () => {
      resolveLoad(zh)
    })

    await waitFor(() => expect(latest().messages).toBe(zh))
    expect(latest().locale).toBe("zh-CN")
  })

  it("stays on the default bundle when the non-default chunk fails to load", async () => {
    mockSettingsState = { settings: { language: "zh-CN" }, loaded: true }
    loadMessagesMock.mockRejectedValue(new Error("chunk load failed"))

    render(<LocaleGate>child</LocaleGate>)
    expect(latest().messages).toBe(defaultMessages)

    // Flush the rejection microtask — the gate's .catch keeps the fallback.
    await act(async () => {
      await Promise.resolve()
    })
    expect(latest().messages).toBe(defaultMessages)
    expect(latest().locale).toBe("zh-CN")
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
})
