import { act, render, screen } from "@testing-library/react"

import {
  __resetPluginI18nForTesting,
  registerPluginI18n,
  unregisterPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"
import { useSettingsStore } from "@/stores"

import { createI18nAPI } from "./i18n-api"
import { usePluginTranslations } from "./use-plugin-translations"

const PLUGIN = "acme-weather"

function registerBundle() {
  registerPluginI18n({
    pluginId: PLUGIN,
    messages: {
      en: {
        [`plugin.${PLUGIN}.card.title`]: "Weather in {city}",
        [`plugin.${PLUGIN}.card.onlyEnglish`]: "English only",
      },
      "zh-CN": { [`plugin.${PLUGIN}.card.title`]: "{city}的天气" },
    },
  })
}

function Card({ keyName, city }: { keyName: string; city?: string }) {
  const t = usePluginTranslations(PLUGIN)
  return <p>{t(keyName, city ? { city } : undefined)}</p>
}

describe("usePluginTranslations", () => {
  const initialLanguage = useSettingsStore.getState().language

  beforeEach(() => {
    __resetPluginI18nForTesting()
    act(() => useSettingsStore.setState({ language: "en" }))
  })

  afterAll(() => {
    act(() => useSettingsStore.setState({ language: initialLanguage }))
  })

  it("translates the plugin's unprefixed keys with interpolation", () => {
    registerBundle()
    render(<Card keyName="card.title" city="Oslo" />)
    expect(screen.getByText("Weather in Oslo")).toBeInTheDocument()
  })

  it("follows the user's language and falls back to English, then the key", () => {
    registerBundle()
    const { rerender } = render(<Card keyName="card.title" city="Oslo" />)
    act(() => useSettingsStore.setState({ language: "zh-CN" }))
    expect(screen.getByText("Oslo的天气")).toBeInTheDocument()

    rerender(<Card keyName="card.onlyEnglish" />)
    expect(screen.getByText("English only")).toBeInTheDocument()

    rerender(<Card keyName="card.missing" />)
    expect(screen.getByText("card.missing")).toBeInTheDocument()
  })

  it("re-renders when the plugin's bundle registers after first paint", () => {
    render(<Card keyName="card.title" city="Oslo" />)
    expect(screen.getByText("card.title")).toBeInTheDocument()
    act(() => registerBundle())
    expect(screen.getByText("Weather in Oslo")).toBeInTheDocument()
    act(() => {
      unregisterPluginI18n(PLUGIN)
    })
    expect(screen.getByText("card.title")).toBeInTheDocument()
  })

  it("answers exactly what ctx.i18n.t answers for the same key", () => {
    registerBundle()
    act(() => useSettingsStore.setState({ language: "zh-CN" }))
    render(<Card keyName="card.title" city="Oslo" />)
    expect(screen.getByText(createI18nAPI(PLUGIN).t("card.title", { city: "Oslo" }))).toBeTruthy()
  })
})
