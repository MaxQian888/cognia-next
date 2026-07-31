/**
 * Pins the `open-settings` actions to the real settings navigation.
 *
 * `DiagnosticAction`'s `section` is typed `string` inside
 * `@cognia/diagnostics` on purpose: the package is zero-`@/` so it can be built
 * standalone, and `SettingsSectionId` lives in a `.tsx` module under
 * `components/`. That keeps the package clean but leaves a real gap — a typo,
 * or a section renamed out from under us, would ship a button that navigates
 * nowhere.
 *
 * The repo's convention for a contract that the compiler can't hold is to pin
 * it with a test, so that is what this is. It runs on the app side, where both
 * halves are importable.
 */

import { DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS } from "@cognia/diagnostics"
import { SETTINGS_NAV, type SettingsSectionId } from "@/components/settings/settings-nav-config"

/** Sections a diagnostic is allowed to deep-link to, straight from the nav. */
const NAV_SECTIONS = new Set<string>(SETTINGS_NAV.map((item) => item.id))

describe("diagnostic open-settings targets", () => {
  it("only points at sections that exist in the settings navigation", () => {
    const bad = DIAGNOSTIC_CODE_IDS.flatMap((code) =>
      DIAGNOSTIC_CODES[code].actions
        .filter((action) => action.kind === "open-settings")
        .filter((action) => !NAV_SECTIONS.has(action.section))
        .map((action) => `${code} → ${action.section}`)
    )
    expect(bad).toEqual([])
  })

  it("type-checks each target as a SettingsSectionId", () => {
    // Compile-time half of the same guarantee: if a literal below stops being a
    // member of the union, `pnpm typecheck` fails before this test ever runs.
    const sampled: SettingsSectionId[] = [
      "providers",
      "subscription",
      "external-bridge",
      "agent-runtime",
      "agent-teams",
      "plugins",
      "network",
      "remote-hosts",
      "subagents",
      "agent-modes",
    ]
    for (const section of sampled) {
      expect(NAV_SECTIONS.has(section)).toBe(true)
    }
  })
})
