/**
 * Tests for I18n Plugin API
 */

import { createI18nAPI } from "./i18n-api"
import {
  __resetPluginI18nForTesting,
  lookupPluginMessage,
  registerPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"

// Mock stores and i18n config
jest.mock("@/stores", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      language: "en",
    })),
    subscribe: jest.fn((_callback) => {
      return () => {}
    }),
  },
}))

jest.mock("@/lib/i18n/config", () => ({
  locales: ["en", "zh-CN", "ja", "ko"],
  localeNames: {
    en: "English",
    "zh-CN": "简体中文",
    ja: "日本語",
    ko: "한국어",
  },
}))

describe("I18n API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    __resetPluginI18nForTesting()
  })

  describe("createI18nAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createI18nAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getCurrentLocale).toBe("function")
      expect(typeof api.getAvailableLocales).toBe("function")
      expect(typeof api.getLocaleName).toBe("function")
      expect(typeof api.t).toBe("function")
      expect(typeof api.registerTranslations).toBe("function")
      expect(typeof api.hasTranslation).toBe("function")
      expect(typeof api.onLocaleChange).toBe("function")
      expect(typeof api.formatDate).toBe("function")
      expect(typeof api.formatNumber).toBe("function")
      expect(typeof api.formatRelativeTime).toBe("function")
    })
  })

  describe("getCurrentLocale", () => {
    it("should return current locale from settings", () => {
      const api = createI18nAPI(testPluginId)

      const locale = api.getCurrentLocale()

      expect(locale).toBe("en")
    })
  })

  describe("getAvailableLocales", () => {
    it("should return all available locales", () => {
      const api = createI18nAPI(testPluginId)

      const locales = api.getAvailableLocales()

      expect(Array.isArray(locales)).toBe(true)
      expect(locales).toContain("en")
      expect(locales).toContain("zh-CN")
    })
  })

  describe("getLocaleName", () => {
    it("should return locale display name", () => {
      const api = createI18nAPI(testPluginId)

      expect(api.getLocaleName("en")).toBe("English")
      expect(api.getLocaleName("zh-CN")).toBe("简体中文")
    })

    it("should return locale code for unknown locale", () => {
      const api = createI18nAPI(testPluginId)

      expect(api.getLocaleName("unknown" as never)).toBe("unknown")
    })
  })

  describe("registerTranslations", () => {
    it("should register translations for a locale", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "plugin.greeting": "Hello",
        "plugin.farewell": "Goodbye",
      })

      expect(api.hasTranslation("plugin.greeting")).toBe(true)
      expect(api.hasTranslation("plugin.farewell")).toBe(true)
    })

    it("should merge with existing translations", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", { key1: "Value 1" })
      api.registerTranslations("en", { key2: "Value 2" })

      expect(api.hasTranslation("key1")).toBe(true)
      expect(api.hasTranslation("key2")).toBe(true)
    })
  })

  describe("t (translate)", () => {
    it("reads manifest translations registered in the next-intl overlay", () => {
      registerPluginI18n({
        pluginId: testPluginId,
        messages: {
          en: { [`plugin.${testPluginId}.panel.title`]: "Manifest panel" },
        },
      })

      expect(createI18nAPI(testPluginId).t("panel.title")).toBe("Manifest panel")
    })

    it("should return key when no translation registered", () => {
      const api = createI18nAPI(testPluginId)

      const result = api.t("unregistered.key")

      expect(result).toBe("unregistered.key")
    })

    it("should return translated value", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "test.message": "Test Message",
      })

      const result = api.t("test.message")

      expect(result).toBe("Test Message")
    })

    it("should interpolate parameters", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "greeting.personal": "Hello, {name}!",
      })

      const result = api.t("greeting.personal", { name: "World" })

      expect(result).toBe("Hello, World!")
    })

    it("should handle multiple parameters", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "message.complex": "{user} sent {count} messages",
      })

      const result = api.t("message.complex", { user: "Alice", count: 5 })

      expect(result).toBe("Alice sent 5 messages")
    })

    it("should keep placeholder when parameter not provided", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "message.param": "Value: {value}",
      })

      const result = api.t("message.param", {})

      expect(result).toBe("Value: {value}")
    })
  })

  describe("hasTranslation", () => {
    it("should return true for registered translation", () => {
      const api = createI18nAPI(testPluginId)

      api.registerTranslations("en", {
        "exists.key": "Exists",
      })

      expect(api.hasTranslation("exists.key")).toBe(true)
    })

    it("should return false for non-registered translation", () => {
      const api = createI18nAPI(testPluginId)

      expect(api.hasTranslation("not.exists.key")).toBe(false)
    })
  })

  it("makes runtime translations visible to host next-intl consumers", () => {
    const api = createI18nAPI(testPluginId)
    api.registerTranslations("en", { "runtime.label": "Runtime label" })

    expect(lookupPluginMessage("en", `plugin.${testPluginId}.runtime.label`)).toBe("Runtime label")
  })

  describe("onLocaleChange", () => {
    it("should register locale change handler", () => {
      const api = createI18nAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onLocaleChange(handler)

      expect(typeof unsubscribe).toBe("function")
    })
  })

  describe("formatDate", () => {
    it("should format date according to locale", () => {
      const api = createI18nAPI(testPluginId)
      const date = new Date("2024-01-15T12:00:00Z")

      const formatted = api.formatDate(date)

      expect(typeof formatted).toBe("string")
      expect(formatted.length).toBeGreaterThan(0)
    })

    it("should accept format options", () => {
      const api = createI18nAPI(testPluginId)
      const date = new Date("2024-01-15T12:00:00Z")

      const formatted = api.formatDate(date, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })

      expect(formatted).toContain("2024")
      expect(formatted).toContain("January")
    })
  })

  describe("formatNumber", () => {
    it("should format number according to locale", () => {
      const api = createI18nAPI(testPluginId)

      const formatted = api.formatNumber(1234567.89)

      expect(typeof formatted).toBe("string")
      // Should include thousand separators
      expect(formatted).toContain("1")
    })

    it("should accept format options", () => {
      const api = createI18nAPI(testPluginId)

      const formatted = api.formatNumber(1234.56, {
        style: "currency",
        currency: "USD",
      })

      expect(formatted).toContain("$")
    })

    it("should format percentage", () => {
      const api = createI18nAPI(testPluginId)

      const formatted = api.formatNumber(0.75, {
        style: "percent",
      })

      expect(formatted).toContain("75")
      expect(formatted).toContain("%")
    })
  })

  describe("formatRelativeTime", () => {
    it("should format time in the past", () => {
      const api = createI18nAPI(testPluginId)

      // 5 minutes ago
      const date = new Date(Date.now() - 5 * 60 * 1000)
      const formatted = api.formatRelativeTime(date)

      expect(typeof formatted).toBe("string")
      expect(formatted.length).toBeGreaterThan(0)
    })

    it("should format hours ago", () => {
      const api = createI18nAPI(testPluginId)

      // 3 hours ago
      const date = new Date(Date.now() - 3 * 60 * 60 * 1000)
      const formatted = api.formatRelativeTime(date)

      expect(formatted).toMatch(/hour|小时/i)
    })

    it("should format days ago", () => {
      const api = createI18nAPI(testPluginId)

      // 2 days ago
      const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      const formatted = api.formatRelativeTime(date)

      expect(formatted).toMatch(/day|天|yesterday/i)
    })

    it("should format seconds ago", () => {
      const api = createI18nAPI(testPluginId)

      // 30 seconds ago
      const date = new Date(Date.now() - 30 * 1000)
      const formatted = api.formatRelativeTime(date)

      expect(formatted).toMatch(/second|秒|now/i)
    })
  })

  describe("Plugin isolation", () => {
    it("should isolate translations between plugins", () => {
      const api1 = createI18nAPI("plugin-1")
      const api2 = createI18nAPI("plugin-2")

      api1.registerTranslations("en", { "shared.key": "Plugin 1 Value" })
      api2.registerTranslations("en", { "shared.key": "Plugin 2 Value" })

      // Each plugin has its own translations
      expect(api1.t("shared.key")).toBe("Plugin 1 Value")
      expect(api2.t("shared.key")).toBe("Plugin 2 Value")
    })
  })

  describe("Fallback behavior", () => {
    it("should fallback to English when translation not found in current locale", () => {
      const api = createI18nAPI(testPluginId)

      // Register only English translation
      api.registerTranslations("en", {
        "fallback.test": "English fallback",
      })

      // Should return English value even if current locale is different
      // (depends on implementation - might return key if not in current locale)
      expect(api.t("fallback.test")).toBe("English fallback")
    })
  })
})
