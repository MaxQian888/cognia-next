/**
 * Gate for the diagnostics vocabulary's translations.
 *
 * `pnpm lint:i18n` cannot protect these keys. It resolves only *literal*
 * `t("key")` calls, and every diagnostics renderer necessarily builds its key
 * from data — `` t(`code.${diag.code}.label`) `` — which the gate reports as a
 * skipped dynamic reference and never fails on. So a code added to the registry
 * without a translation would ship as a raw identifier on screen, which is
 * exactly the bug this whole change exists to remove
 * (`ecosystem_prerequisite_missing` in a Badge).
 *
 * This test closes that hole by deriving the expected key set from the registry
 * itself and checking it against both locale bundles.
 */

import {
  DIAGNOSTIC_ACTION_KINDS,
  DIAGNOSTIC_CODE_IDS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  actionI18nKey,
  sourceI18nKey,
} from "@cognia/diagnostics"
import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"

type Bundle = Record<string, unknown>

const LOCALES: ReadonlyArray<readonly [string, Bundle]> = [
  ["en", en as unknown as Bundle],
  ["zh-CN", zh as unknown as Bundle],
]

function at(bundle: Bundle, path: string): unknown {
  return path.split(".").reduce<unknown>((cursor, segment) => {
    if (cursor && typeof cursor === "object" && segment in (cursor as Bundle)) {
      return (cursor as Bundle)[segment]
    }
    return undefined
  }, bundle)
}

function missing(paths: readonly string[]): Array<{ locale: string; path: string }> {
  const gaps: Array<{ locale: string; path: string }> = []
  for (const [locale, bundle] of LOCALES) {
    for (const path of paths) {
      const value = at(bundle, path)
      if (typeof value !== "string" || value.trim() === "") gaps.push({ locale, path })
    }
  }
  return gaps
}

describe("diagnostics i18n parity", () => {
  it("gives every code a label in both locales", () => {
    expect(missing(DIAGNOSTIC_CODE_IDS.map((c) => `diagnostics.code.${c}.label`))).toEqual([])
  })

  it("gives every code a hint in both locales", () => {
    // The hint is what turns "Rate limited" into something the user can act on.
    // A code with a label but no hint reads as a dead end.
    expect(missing(DIAGNOSTIC_CODE_IDS.map((c) => `diagnostics.code.${c}.hint`))).toEqual([])
  })

  it("gives every action kind a button label in both locales", () => {
    expect(
      missing(DIAGNOSTIC_ACTION_KINDS.map((k) => `diagnostics.action.${actionI18nKey(k)}`))
    ).toEqual([])
  })

  it("gives every source and severity a name in both locales", () => {
    expect(
      missing([
        ...DIAGNOSTIC_SOURCES.map((s) => `diagnostics.source.${sourceI18nKey(s)}`),
        ...DIAGNOSTIC_SEVERITIES.map((s) => `diagnostics.severity.${s}`),
      ])
    ).toEqual([])
  })

  it("has no orphan code entries left behind by a removed code", () => {
    const known = new Set<string>(DIAGNOSTIC_CODE_IDS)
    for (const [locale, bundle] of LOCALES) {
      const codes = at(bundle, "diagnostics.code") as Record<string, unknown>
      const orphans = Object.keys(codes).filter((key) => !known.has(key))
      expect({ locale, orphans }).toEqual({ locale, orphans: [] })
    }
  })

  it("has no orphan action entries", () => {
    const known = new Set(DIAGNOSTIC_ACTION_KINDS.map(actionI18nKey))
    for (const [locale, bundle] of LOCALES) {
      const actions = at(bundle, "diagnostics.action") as Record<string, unknown>
      const orphans = Object.keys(actions).filter((key) => !known.has(key))
      expect({ locale, orphans }).toEqual({ locale, orphans: [] })
    }
  })

  it("keeps the two locales structurally identical under `diagnostics`", () => {
    const flatten = (value: unknown, prefix = ""): string[] => {
      if (typeof value !== "object" || value === null) return [prefix]
      return Object.entries(value as Bundle).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key)
      )
    }
    const [enKeys, zhKeys] = LOCALES.map(([, bundle]) => flatten(at(bundle, "diagnostics")).sort())
    expect(zhKeys).toEqual(enKeys)
  })
})
