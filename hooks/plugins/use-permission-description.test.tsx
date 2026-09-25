/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderHook } from "@testing-library/react"

// A locale-switchable next-intl double backed by the SPLIT sources
// (`i18n/messages/<locale>/plugins/permissions.json`), so these tests exercise
// the real copy without depending on the generated aggregates.
jest.mock("next-intl", () => {
  const bundles: Record<string, Record<string, unknown>> = {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    en: require("../../i18n/messages/en/plugins/permissions.json"),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    "zh-CN": require("../../i18n/messages/zh-CN/plugins/permissions.json"),
    empty: {},
  }
  const state = { locale: "en", withHas: true }
  const cache = new Map<string, unknown>()
  const lookup = (namespace: string, key: string): unknown => {
    let cursor: unknown = { plugins: { permissions: bundles[state.locale] } }
    for (const segment of [...namespace.split("."), key]) {
      if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, segment)) {
        return undefined
      }
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    return cursor
  }
  return {
    // Translators are cached per locale + namespace, mirroring next-intl's
    // memoized `useTranslations` so hook-identity assertions are meaningful.
    useTranslations: (namespace: string) => {
      const cacheKey = `${state.locale}|${state.withHas}|${namespace}`
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const t = (key: string) => {
        const value = lookup(namespace, key)
        return typeof value === "string" ? value : `${namespace}.${key}`
      }
      if (state.withHas) {
        ;(t as unknown as { has: (key: string) => boolean }).has = (key: string) =>
          typeof lookup(namespace, key) === "string"
      }
      cache.set(cacheKey, t)
      return t
    },
    __setMockLocale: (locale: string) => {
      state.locale = locale
    },
    __setMockHasSupport: (enabled: boolean) => {
      state.withHas = enabled
    },
  }
})

import { PERMISSION_DESCRIPTIONS } from "@/lib/plugin/security/permission-guard"
import { usePermissionDescription } from "./use-permission-description"

const intlControls = jest.requireMock("next-intl") as {
  __setMockLocale: (locale: "en" | "zh-CN" | "empty") => void
  __setMockHasSupport: (enabled: boolean) => void
}

afterEach(() => {
  intlControls.__setMockLocale("en")
  intlControls.__setMockHasSupport(true)
})

describe("usePermissionDescription", () => {
  it("returns the English description from the en bundle", () => {
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("filesystem:read")).toBe("Read files from the file system")
    expect(result.current("notification")).toBe("Show system notifications")
  })

  it("returns the Simplified Chinese description in zh-CN", () => {
    intlControls.__setMockLocale("zh-CN")
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("filesystem:read")).toBe("读取文件系统中的文件")
    expect(result.current("shell:execute")).toBe("执行 Shell 命令")
  })

  it("falls back to the raw id for a permission nobody describes", () => {
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("custom:unknown-permission")).toBe("custom:unknown-permission")
  })

  it("prefers a caller fallback over the raw id for an unknown permission", () => {
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("custom:unknown-permission", "Custom permission")).toBe(
      "Custom permission"
    )
    // A known permission ignores the fallback.
    expect(result.current("network:fetch", "Custom permission")).toBe("Make HTTP/HTTPS requests")
  })

  it("falls back to the English guard copy when the locale has no key yet", () => {
    intlControls.__setMockLocale("empty")
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("network:upload")).toBe(PERMISSION_DESCRIPTIONS["network:upload"])
  })

  it("does not treat inherited object members as descriptions", () => {
    intlControls.__setMockLocale("empty")
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("constructor")).toBe("constructor")
  })

  it("tolerates a translator without has() by using the English guard copy", () => {
    intlControls.__setMockLocale("zh-CN")
    intlControls.__setMockHasSupport(false)
    const { result } = renderHook(() => usePermissionDescription())
    expect(result.current("clipboard:read")).toBe(PERMISSION_DESCRIPTIONS["clipboard:read"])
  })

  it("returns a stable function across re-renders", () => {
    const { result, rerender } = renderHook(() => usePermissionDescription())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

// Parity between the English guard table and BOTH locale split sources. The
// consent / review / marketplace surfaces render these keys, so a permission
// added to the guard without copy here would show English to zh-CN users.
describe("permission description i18n parity", () => {
  const readDescriptions = (locale: "en" | "zh-CN"): Record<string, unknown> => {
    const file = join(
      __dirname,
      "..",
      "..",
      "i18n",
      "messages",
      locale,
      "plugins",
      "permissions.json"
    )
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { descriptions?: unknown }
    expect(parsed.descriptions).toEqual(expect.any(Object))
    return parsed.descriptions as Record<string, unknown>
  }
  const permissionIds = Object.keys(PERMISSION_DESCRIPTIONS).sort()

  it.each(["en", "zh-CN"] as const)(
    "%s describes every permission in PERMISSION_DESCRIPTIONS",
    (locale) => {
      const descriptions = readDescriptions(locale)
      const missing = permissionIds.filter((id) => {
        const value = descriptions[id]
        return typeof value !== "string" || value.trim() === ""
      })
      expect(missing).toEqual([])
    }
  )

  it.each(["en", "zh-CN"] as const)("%s has no orphan description keys", (locale) => {
    const orphans = Object.keys(readDescriptions(locale)).filter(
      (id) => !Object.hasOwn(PERMISSION_DESCRIPTIONS, id)
    )
    expect(orphans).toEqual([])
  })

  it("keeps the en copy identical to the guard's English source of truth", () => {
    const descriptions = readDescriptions("en")
    const drifted = permissionIds.filter(
      (id) =>
        descriptions[id] !== PERMISSION_DESCRIPTIONS[id as keyof typeof PERMISSION_DESCRIPTIONS]
    )
    expect(drifted).toEqual([])
  })

  it("translates every zh-CN description instead of copying the English text", () => {
    const descriptions = readDescriptions("zh-CN")
    const untranslated = permissionIds.filter((id) => {
      const value = descriptions[id]
      return typeof value !== "string" || !/[\u4e00-\u9fff]/.test(value)
    })
    expect(untranslated).toEqual([])
  })
})
