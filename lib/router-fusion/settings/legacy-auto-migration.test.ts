import { DEFAULT_AUTO_ROUTER_SETTINGS } from "@cognia/provider-types/auto-router"
import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  normalizeRouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import {
  enableRouterFusion,
  MIGRATED_RULE_ROW,
  restoreLegacyAuto,
  showsLegacyAutoNotice,
} from "./legacy-auto-migration"

const off = () => structuredClone(DEFAULT_ROUTER_FUSION_SETTINGS)
const legacyAuto = { ...DEFAULT_AUTO_ROUTER_SETTINGS, enabled: true, maxCostPerRequest: 12.5 }

describe("legacy Auto migration", () => {
  it("carries a legacy Auto user's ladder and cost limit over on the first enable", () => {
    const next = enableRouterFusion(off(), legacyAuto, 1_000)
    expect(next.enabled).toBe(true)
    expect(next.approvedRuleRows).toEqual([MIGRATED_RULE_ROW])
    expect(next.ruleRowProvenance).toEqual({ [MIGRATED_RULE_ROW]: "migrated_legacy_auto" })
    // 12.5 cents is $0.125 — the cap never rounds looser.
    expect(next.runCapUsdByMode.direct).toBe("0.125000")
    expect(next.legacyAutoSnapshot).toEqual({ capturedAt: 1_000, autoRouting: legacyAuto })
    expect(showsLegacyAutoNotice(next)).toBe(true)
    // Surfaces stay off: enabling the master alone routes nothing.
    expect(Object.values(next.surfaces).every((on) => on === false)).toBe(true)
  })

  it("migrates nothing and announces nothing for a user without Auto", () => {
    const next = enableRouterFusion(off(), DEFAULT_AUTO_ROUTER_SETTINGS, 1_000)
    expect(next.approvedRuleRows).toEqual([])
    expect(next.runCapUsdByMode.direct).toBe(DEFAULT_ROUTER_FUSION_SETTINGS.runCapUsdByMode.direct)
    expect(showsLegacyAutoNotice(next)).toBe(false)
    expect(next.legacyAutoSnapshot?.capturedAt).toBe(1_000)
  })

  it("migrates only the first time", () => {
    const first = enableRouterFusion(off(), legacyAuto, 1_000)
    const userEdited = normalizeRouterFusionSettings({
      ...first,
      enabled: false,
      approvedRuleRows: [],
      ruleRowProvenance: {},
      runCapUsdByMode: { ...first.runCapUsdByMode, direct: "0.30" },
    })
    const again = enableRouterFusion(userEdited, { ...legacyAuto, maxCostPerRequest: 99 }, 2_000)
    expect(again.enabled).toBe(true)
    expect(again.approvedRuleRows).toEqual([])
    expect(again.runCapUsdByMode.direct).toBe("0.30")
    expect(again.legacyAutoSnapshot?.capturedAt).toBe(1_000)
  })

  it("keeps a row the user already approved as the user's", () => {
    const approved = normalizeRouterFusionSettings({
      approvedRuleRows: [MIGRATED_RULE_ROW],
      ruleRowProvenance: { [MIGRATED_RULE_ROW]: "user" },
    })
    const next = enableRouterFusion(approved, legacyAuto, 1)
    expect(next.ruleRowProvenance).toEqual({ [MIGRATED_RULE_ROW]: "user" })
  })

  it("restores in one click: Router + Fusion off, migrated rows withdrawn, Auto put back", () => {
    const enabled = enableRouterFusion(off(), legacyAuto, 1_000)
    const withUserRow = normalizeRouterFusionSettings({
      ...enabled,
      approvedRuleRows: [...enabled.approvedRuleRows, "panel_research"],
      ruleRowProvenance: { ...enabled.ruleRowProvenance, panel_research: "user" },
    })
    const restored = restoreLegacyAuto(withUserRow)
    expect(restored.autoRouting).toEqual(legacyAuto)
    expect(restored.routerFusion.enabled).toBe(false)
    expect(restored.routerFusion.approvedRuleRows).toEqual(["panel_research"])
    expect(restored.routerFusion.ruleRowProvenance).toEqual({ panel_research: "user" })
    expect(restored.routerFusion.legacyAutoSnapshot).toBeUndefined()
    expect(showsLegacyAutoNotice(restored.routerFusion)).toBe(false)
  })

  it("restores without touching Auto when nothing was captured", () => {
    expect(restoreLegacyAuto(off())).toEqual({
      routerFusion: expect.objectContaining({ enabled: false }),
    })
  })
})
