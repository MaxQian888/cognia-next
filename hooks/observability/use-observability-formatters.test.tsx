/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

// jest.setup.ts stubs next-intl with `useFormatter().number = String(n)`, and
// the real package is ESM-only and outside the repo's transform allow-list, so
// `jest.requireActual("next-intl")` cannot load. This mock reproduces exactly
// what next-intl's `useFormatter` does with the hook's arguments — hand them,
// with the provider's locale and time zone, to `Intl.NumberFormat` /
// `Intl.DateTimeFormat` — and memoizes per locale the way next-intl memoizes on
// its context. What is under test is the options this hook picks, run through
// the real ICU data for each locale.
jest.mock("next-intl", () => {
  const state = { locale: "en", timeZone: "UTC" }
  const cache = new Map<string, unknown>()
  return {
    __setIntl: (locale: string) => {
      state.locale = locale
    },
    useFormatter: () => {
      const key = `${state.locale}|${state.timeZone}`
      let formatter = cache.get(key)
      if (!formatter) {
        const { locale, timeZone } = state
        formatter = {
          number: (value: number, options?: Intl.NumberFormatOptions) =>
            new Intl.NumberFormat(locale, options).format(value),
          dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
            new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(value),
        }
        cache.set(key, formatter)
      }
      return formatter
    },
  }
})

import * as nextIntl from "next-intl"
import { useObservabilityFormatters } from "./use-observability-formatters"

const setIntl = (nextIntl as unknown as { __setIntl: (locale: string) => void }).__setIntl

function render(locale: "en" | "zh-CN") {
  setIntl(locale)
  return renderHook(() => useObservabilityFormatters()).result
}

/** 2026-10-03T14:03:22Z */
const TS = Date.UTC(2026, 9, 3, 14, 3, 22)

describe("useObservabilityFormatters", () => {
  describe("en", () => {
    it("formats durations with narrow units across ms / s / min", () => {
      const f = render("en").current
      expect(f.duration(850)).toBe("850ms")
      expect(f.duration(849.6)).toBe("850ms")
      expect(f.duration(1_244.9)).toBe("1.24s")
      expect(f.duration(150_000)).toBe("2.5m")
    })

    it("clamps a negative duration to zero", () => {
      expect(render("en").current.duration(-5)).toBe("0ms")
    })

    it("formats USD with adaptive precision", () => {
      const f = render("en").current
      expect(f.usd(0)).toBe("$0.00")
      expect(f.usd(3.5)).toBe("$3.50")
      expect(f.usd(0.0012)).toBe("$0.0012")
      expect(f.usd(-0.0012)).toBe("-$0.0012")
    })

    it("formats compact counts", () => {
      const f = render("en").current
      expect(f.compact(950)).toBe("950")
      expect(f.compact(12_345)).toBe("12.3K")
      expect(f.compact(3_400_000)).toBe("3.4M")
    })

    it("formats grouped integers and bounded decimals", () => {
      const f = render("en").current
      expect(f.integer(1_234.6)).toBe("1,235")
      expect(f.decimal(1.23456)).toBe("1.23")
      expect(f.decimal(1.23456, 3)).toBe("1.235")
      expect(f.decimal(2)).toBe("2")
    })

    it("formats percentages with exactly `digits` fraction digits", () => {
      const f = render("en").current
      expect(f.percent(0.5)).toBe("50%")
      expect(f.percent(0.125, 1)).toBe("12.5%")
      expect(f.percent(0.5, 2)).toBe("50.00%")
    })

    it("formats times and dates in the provider's time zone", () => {
      const f = render("en").current
      expect(f.time(TS)).toMatch(/^02:03:22\sPM$/)
      expect(f.dateTime(TS)).toMatch(/^Oct 3, 02:03\sPM$/)
    })

    it("passes explicit date options straight through", () => {
      const f = render("en").current
      expect(f.dateTimeWith(TS, { year: "numeric", month: "2-digit", day: "2-digit" })).toBe(
        "10/03/2026"
      )
      expect(f.dateTimeWith(TS, { hour: "2-digit", minute: "2-digit", hour12: false })).toBe(
        "14:03"
      )
    })

    it("renders an em-dash for missing or non-finite numbers", () => {
      const f = render("en").current
      for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(f.duration(bad)).toBe("—")
        expect(f.usd(bad)).toBe("—")
        expect(f.compact(bad)).toBe("—")
        expect(f.integer(bad)).toBe("—")
        expect(f.decimal(bad)).toBe("—")
        expect(f.percent(bad)).toBe("—")
      }
    })

    it("keeps the same formatter object across re-renders", () => {
      setIntl("en")
      const { result, rerender } = renderHook(() => useObservabilityFormatters())
      const first = result.current
      rerender()
      expect(result.current).toBe(first)
    })
  })

  describe("zh-CN", () => {
    it("follows the app locale, not the browser's", () => {
      const en = render("en").current
      const zh = render("zh-CN").current
      expect(zh.usd(3.5)).not.toBe(en.usd(3.5))
      expect(zh.compact(12_345)).not.toBe(en.compact(12_345))
      expect(zh.duration(1_244.9)).not.toBe(en.duration(1_244.9))
      expect(zh.time(TS)).not.toBe(en.time(TS))
    })

    it("uses Chinese currency, compact and unit forms", () => {
      const f = render("zh-CN").current
      expect(f.usd(3.5)).toBe("US$3.50")
      expect(f.compact(12_345)).toBe("1.2万")
      expect(f.duration(1_244.9)).toBe("1.24秒")
      expect(f.duration(150_000)).toBe("2.5分钟")
    })

    it("uses a 24-hour clock and Chinese date order", () => {
      const f = render("zh-CN").current
      expect(f.time(TS)).toBe("14:03:22")
      expect(f.dateTime(TS)).toBe("10月3日 14:03")
    })

    it("still renders an em-dash for non-finite input", () => {
      const f = render("zh-CN").current
      expect(f.usd(Number.NaN)).toBe("—")
      expect(f.percent(null)).toBe("—")
    })
  })
})
