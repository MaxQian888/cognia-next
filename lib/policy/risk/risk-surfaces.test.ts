import en from "@/i18n/messages/en/policy.json"
import zh from "@/i18n/messages/zh-CN/policy.json"
import {
  RISK_SURFACES,
  RISK_SURFACE_IDS,
  riskSurfaceMeta,
  type RiskSurfaceId,
} from "./risk-surfaces"

/**
 * The taxonomy is the contract between the classifier and every future UI. A
 * surface added without a meta entry is a compile error; these tests cover the
 * things the compiler cannot see — that the severity is one of the two legal
 * values, and that the i18n key actually resolves in BOTH locales.
 */
describe("RISK_SURFACES", () => {
  const messages: Record<string, typeof en> = { en, "zh-CN": zh }

  it("enumerates every surface", () => {
    expect(RISK_SURFACE_IDS.sort()).toEqual([
      "computer-use",
      "credential-auth",
      "data-destructive",
      "external-send",
      "file-write-broad",
      "native-command",
    ])
  })

  it.each(Object.keys(RISK_SURFACES) as RiskSurfaceId[])("%s has legal metadata", (id) => {
    const meta = riskSurfaceMeta(id)
    expect(["elevated", "high"]).toContain(meta.severity)
    // The key mirrors the id so a renamed surface cannot silently keep a stale key.
    expect(meta.i18nKey).toBe(id)
  })

  describe.each(["en", "zh-CN"])("%s messages", (locale) => {
    it.each(Object.keys(RISK_SURFACES) as RiskSurfaceId[])(
      "resolves a label + description for %s",
      (id) => {
        const entry = messages[locale].risk.surfaces[riskSurfaceMeta(id).i18nKey]
        expect(entry?.label).toBeTruthy()
        expect(entry?.description).toBeTruthy()
      }
    )
  })

  it("keeps the two locales at key parity", () => {
    expect(Object.keys(zh.risk.surfaces).sort()).toEqual(Object.keys(en.risk.surfaces).sort())
    expect(Object.keys(zh.risk.tier).sort()).toEqual(Object.keys(en.risk.tier).sort())
  })
})
