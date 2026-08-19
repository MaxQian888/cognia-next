/**
 * Pins the shared level list. Every level `<Select>` in the section maps over
 * this array, and each option needs a `settings.logLevel.<level>` message — a
 * level added here without its two strings renders as a raw key.
 */

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

import { LOG_LEVELS } from "./log-levels"

const bundles = { en: enMessages, "zh-CN": zhMessages } as const

describe("LOG_LEVELS", () => {
  it("lists the six severities in ascending order", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"])
  })

  it.each(Object.entries(bundles))("has a name and a description in %s", (_locale, bundle) => {
    const levels = (bundle as typeof enMessages).logging.settings.logLevel as Record<string, string>
    for (const level of LOG_LEVELS) {
      expect(typeof levels[level]).toBe("string")
      expect(typeof levels[`${level}Desc`]).toBe("string")
    }
  })
})
