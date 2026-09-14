/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { usePluginT } from "./use-plugin-t"
import { I18N_MESSAGES } from "../i18n"

let locale: string = "en"
jest.mock("next-intl", () => ({ useLocale: () => locale }))

describe("usePluginT", () => {
  it("resolves English keys and interpolates vars", () => {
    locale = "en"
    const { result } = renderHook(() => usePluginT())
    expect(result.current("modal.title")).toBe(I18N_MESSAGES.en["modal.title"])
    expect(result.current("modal.env.ready", { node: "v22", npx: "10" })).toBe(
      "Node.js v22 · npx 10 — ready to spawn @playwright/mcp."
    )
  })

  it("resolves zh-CN keys", () => {
    locale = "zh-CN"
    const { result } = renderHook(() => usePluginT())
    expect(result.current("modal.title")).toBe(I18N_MESSAGES["zh-CN"]["modal.title"])
  })

  it("falls back to English for unknown locales, then to the raw key", () => {
    locale = "fr"
    const { result } = renderHook(() => usePluginT())
    expect(result.current("modal.close")).toBe(I18N_MESSAGES.en["modal.close"])
    expect(result.current("no.such.key")).toBe("no.such.key")
  })
})
