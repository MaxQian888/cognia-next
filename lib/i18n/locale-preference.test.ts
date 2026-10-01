/** @jest-environment jsdom */
import {
  BOOT_LOCALE_STORAGE_KEY,
  persistBootLocalePreference,
  readBootLocalePreference,
  resolveLocalePreference,
  resolveSystemLocale,
  subscribeSystemLocale,
} from "./locale-preference"

beforeEach(() => {
  localStorage.clear()
  jest.spyOn(navigator, "languages", "get").mockReturnValue(["zh-Hans-CN", "en-US"])
})
afterEach(() => jest.restoreAllMocks())

it.each([
  [["zh-Hans-CN"], "zh-CN"],
  [["zh-TW"], "zh-CN"],
  [["en-GB", "zh-CN"], "en"],
  [["fr-FR", "zh-CN"], "zh-CN"],
  [["fr-FR"], "en"],
  [[], "en"],
] as const)("resolves ordered system languages %j to %s", (languages, expected) => {
  expect(resolveSystemLocale(languages)).toBe(expected)
})

it("follows the system on first launch but preserves legacy explicit choices", () => {
  expect(resolveLocalePreference()).toEqual({ language: "zh-CN", languageMode: "system" })
  expect(resolveLocalePreference({ language: "en" })).toEqual({
    language: "en",
    languageMode: "manual",
  })
  expect(resolveLocalePreference({ language: "en", languageMode: "system" })).toEqual({
    language: "zh-CN",
    languageMode: "system",
  })
})

it("mirrors only the locale preference and re-resolves system mode at boot", () => {
  persistBootLocalePreference({ language: "en", languageMode: "manual" })
  expect(readBootLocalePreference()).toEqual({ language: "en", languageMode: "manual" })
  persistBootLocalePreference({ language: "en", languageMode: "system" })
  expect(readBootLocalePreference()).toEqual({ language: "zh-CN", languageMode: "system" })
})

it("survives corrupt or unavailable storage", () => {
  localStorage.setItem(BOOT_LOCALE_STORAGE_KEY, "{")
  expect(readBootLocalePreference().language).toBe("zh-CN")
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked")
  })
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full")
  })
  expect(() => persistBootLocalePreference({ language: "en" })).not.toThrow()
  expect(readBootLocalePreference().language).toBe("zh-CN")
})

it("observes language changes and foreground resumes and cleans up", () => {
  const listener = jest.fn()
  const unsubscribe = subscribeSystemLocale(listener)
  window.dispatchEvent(new Event("languagechange"))
  document.dispatchEvent(new Event("visibilitychange"))
  expect(listener).toHaveBeenCalledTimes(2)
  unsubscribe()
  window.dispatchEvent(new Event("languagechange"))
  expect(listener).toHaveBeenCalledTimes(2)
})
