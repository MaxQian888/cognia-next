/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { renderToString } from "react-dom/server"
import type { LocalePreference } from "@/lib/i18n/locale-preference"
import { BOOT_LOCALE_STORAGE_KEY, LOCALE_PREFERENCE_PREF } from "@/lib/i18n/locale-preference"

const refreshSystemLanguage = jest.fn()
const state: {
  loaded: boolean
  settings: Partial<LocalePreference> | null
  refreshSystemLanguage: typeof refreshSystemLanguage
} = {
  loaded: false,
  settings: null,
  refreshSystemLanguage,
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}))
const getPref = jest.fn()
const setPref = jest.fn()
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPref(...args),
  setPref: (...args: unknown[]) => setPref(...args),
}))
import { useAppLocale } from "./use-app-locale"

beforeEach(() => {
  localStorage.clear()
  state.loaded = false
  state.settings = null
  getPref.mockReset().mockResolvedValue(null)
  setPref.mockReset().mockResolvedValue(undefined)
  refreshSystemLanguage.mockReset()
  jest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-Hans-CN"])
})
afterEach(() => jest.restoreAllMocks())

it("keeps server markup deterministic, then follows the system before account unlock", async () => {
  function ServerProbe() {
    return useAppLocale()
  }
  expect(renderToString(<ServerProbe />)).toBe("en")
  const { result } = renderHook(useAppLocale)
  expect(result.current).toBe("zh-CN")
  expect(document.documentElement.lang).toBe("zh-CN")
  await waitFor(() => expect(getPref).toHaveBeenCalled())
})

it("updates on languagechange while system mode is active", () => {
  const { result } = renderHook(useAppLocale)
  jest.spyOn(navigator, "languages", "get").mockReturnValue(["en-GB"])
  act(() => window.dispatchEvent(new Event("languagechange")))
  expect(result.current).toBe("en")
  expect(refreshSystemLanguage).toHaveBeenCalledTimes(2)
})

it("preserves and mirrors a manual choice after settings hydrate", () => {
  const { result, rerender } = renderHook(useAppLocale)
  state.loaded = true
  state.settings = { language: "en", languageMode: "manual" }
  rerender()
  expect(result.current).toBe("en")
  expect(JSON.parse(localStorage.getItem(BOOT_LOCALE_STORAGE_KEY)!)).toEqual(state.settings)
  expect(setPref).toHaveBeenCalledWith(LOCALE_PREFERENCE_PREF, state.settings)
  act(() => window.dispatchEvent(new Event("languagechange")))
  expect(result.current).toBe("en")
})

it("uses the existing native locale mirror on an upgraded installation", async () => {
  getPref.mockImplementation((key: string) =>
    Promise.resolve(key === "appearance.locale" ? "en" : null)
  )
  const { result } = renderHook(useAppLocale)
  await waitFor(() => expect(result.current).toBe("en"))
})

it("does not let a slow native mirror overwrite newly hydrated settings", async () => {
  let finish!: (value: LocalePreference) => void
  getPref.mockImplementation(
    () =>
      new Promise<LocalePreference>((resolve) => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(useAppLocale)
  state.loaded = true
  state.settings = { language: "zh-CN", languageMode: "manual" }
  rerender()
  await act(async () => finish({ language: "en", languageMode: "manual" }))
  expect(result.current).toBe("zh-CN")
  expect(JSON.parse(localStorage.getItem(BOOT_LOCALE_STORAGE_KEY)!).language).toBe("zh-CN")
})

it("keeps boot usable when native preference reads reject", async () => {
  getPref.mockRejectedValue(new Error("native unavailable"))
  const { result } = renderHook(useAppLocale)
  await act(async () => {})
  expect(result.current).toBe("zh-CN")
})
