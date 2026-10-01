/** @jest-environment jsdom */
import { useEffect } from "react"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => {
  const React = jest.requireActual("react")
  const Context = React.createContext("en")
  return {
    NextIntlClientProvider: ({
      locale,
      children,
    }: {
      locale: string
      children: React.ReactNode
    }) => <Context.Provider value={locale}>{children}</Context.Provider>,
    useLocale: () => React.useContext(Context),
    useTimeZone: () => "UTC",
    useTranslations: () => (key: string) => key,
  }
})
jest.mock("@/stores/settings", () => {
  const { create } = jest.requireActual("zustand")
  return {
    useSettingsStore: create(() => ({
      loaded: false,
      settings: null,
      refreshSystemLanguage: () => {},
    })),
  }
})
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(async () => null),
  setPref: jest.fn(async () => {}),
}))
jest.mock("@/i18n/messages", () => ({
  startupMessages: { en: { loading: {} }, "zh-CN": { loading: {} } },
  loadMessages: jest.fn(async () => ({ greeting: "ready" })),
}))
jest.mock("@/components/ui/loading-states", () => ({
  PageLoading: () => <div role="status">loading</div>,
}))
import { useSettingsStore } from "@/stores/settings"
import { loadMessages } from "@/i18n/messages"
import { LightweightLocaleGate } from "./lightweight-locale-gate"
import { FullMessagesGate } from "./full-messages-gate"

it("hydrates Chinese lightweight routes without fetching the full English catalog", async () => {
  localStorage.clear()
  jest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"])
  function Hydrator() {
    useEffect(() => {
      useSettingsStore.setState({
        loaded: true,
        settings: { language: "zh-CN", languageMode: "system" } as never,
      })
    }, [])
    return null
  }
  try {
    render(
      <LightweightLocaleGate>
        <Hydrator />
        <FullMessagesGate>overlay ready</FullMessagesGate>
      </LightweightLocaleGate>
    )
    await screen.findByText("overlay ready")
    expect(loadMessages).toHaveBeenCalledTimes(1)
    expect(loadMessages).toHaveBeenCalledWith("zh-CN")
    expect(document.documentElement.lang).toBe("zh-CN")
  } finally {
    jest.restoreAllMocks()
  }
})
