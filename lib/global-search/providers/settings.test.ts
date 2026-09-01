import { SETTING_CONTROLS } from "@/components/settings/finder/control-registry"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"

import { makeProviderInput, makeTestContext } from "../testing"
import { settingsCandidates, settingsProvider } from "./settings"

const allSections = new Set(SETTINGS_NAV.map((n) => n.id))
const ctxAll = () =>
  makeTestContext({
    host: {
      reachableSettingsSections: allSections,
      recorderAvailable: false,
      theme: "light",
      hasApiKey: false,
      pluginQuickActions: [],
      workbenchPanels: [],
      canBrowseHostFolders: true,
    },
  })

describe("settings provider", () => {
  it("cuts sections and controls to what the host can reach", () => {
    const none = settingsCandidates(makeTestContext())
    expect(none).toEqual([])
    const all = settingsCandidates(ctxAll())
    expect(all.filter((c) => !c.isControl)).toHaveLength(SETTINGS_NAV.length)
    expect(all.filter((c) => c.isControl)).toHaveLength(SETTING_CONTROLS.length)
    const one = settingsCandidates(
      makeTestContext({
        host: {
          reachableSettingsSections: new Set(["appearance"]),
          recorderAvailable: false,
          theme: "light",
          hasApiKey: false,
          pluginQuickActions: [],
          workbenchPanels: [],
          canBrowseHostFolders: true,
        },
      })
    )
    expect(
      one.every((c) => c.id === "section:appearance" || c.action.type === "open-settings")
    ).toBe(true)
    expect(one.some((c) => c.id === "control:language")).toBe(true)
    expect(one.some((c) => c.id === "control:default-model")).toBe(false)
  })

  it("finds a section by id keyword and a control by its bilingual keyword", async () => {
    const section = await settingsProvider.search(
      makeProviderInput("appearance", { ctx: ctxAll() })
    )
    expect(section.items.some((i) => i.id === "settings:section:appearance")).toBe(true)
    const sectionItem = section.items.find((i) => i.id === "settings:section:appearance")!
    expect(sectionItem.action).toEqual({ type: "open-settings", tab: "appearance" })
    expect(sectionItem.subtitle).toBe("settings.descriptions.appearance")

    const control = await settingsProvider.search(makeProviderInput("语言", { ctx: ctxAll() }))
    const languageControl = control.items.find((i) => i.id === "settings:control:language")!
    expect(languageControl).toBeDefined()
    expect(languageControl.action).toEqual({
      type: "open-settings",
      tab: "appearance",
      focus: "language",
    })
    expect(languageControl.meta).toBe("settings.tabs.appearance")
    expect(languageControl.subtitle).toBeUndefined()
  })

  it("matches the translated title and ranks sections above equally-matching controls", async () => {
    // Both a section label and a control label render as their key; search for a
    // shared fragment so both families answer.
    const out = await settingsProvider.search(
      makeProviderInput("settings.", { ctx: ctxAll(), limit: 100 })
    )
    const firstControl = out.items.findIndex((i) => i.id.startsWith("settings:control:"))
    const lastSection = out.items.map((i) => i.id.startsWith("settings:section:")).lastIndexOf(true)
    expect(firstControl).toBeGreaterThan(-1)
    expect(lastSection).toBeLessThan(firstControl)
    expect(out.total).toBe(SETTINGS_NAV.length + SETTING_CONTROLS.length)
  })

  /**
   * The bug the ordering assertion above was a canary for, pinned directly.
   *
   * `matchTitles` sorts by the RAW match score and the control penalty is
   * applied afterwards, in `toItem`. Nothing re-sorted, so the penalty could
   * never do its job, and worse, the array contradicted itself: on an exact
   * score tie `compareByScore` falls through to `title.localeCompare`, which
   * put `settings.finder.controls.theme` above `settings.tabs.externalServices`
   * on "f" versus "t" and returned a 0.924 row BELOW a 0.904 one.
   *
   * Asserted as "no row outscores the row above it" rather than as a fixed
   * pair, so it holds whatever sections and controls get added later. The
   * ordering test above is data-dependent by nature and stopped holding the
   * moment someone added a section whose label ties with a control's.
   */
  it("never returns a row that outscores the one above it", async () => {
    const out = await settingsProvider.search(
      makeProviderInput("settings.", { ctx: ctxAll(), limit: 100 })
    )
    expect(out.items.length).toBeGreaterThan(1)
    const inversions = out.items
      .map((item, n) => ({ item, prev: out.items[n - 1] }))
      .filter(({ item, prev }) => prev !== undefined && item.score > prev.score)
      .map(({ item, prev }) => `${prev!.id} (${prev!.score}) then ${item.id} (${item.score})`)
    expect(inversions).toEqual([])
  })

  /**
   * The penalty is a tie-break, not a demotion. A control whose label genuinely
   * matches better than any section still has to be able to win, or the fix
   * above would have traded one wrong order for another.
   */
  it("still lets a control beat a section it matches better than", async () => {
    const out = await settingsProvider.search(
      makeProviderInput("language", { ctx: ctxAll(), limit: 100 })
    )
    const control = out.items.findIndex((i) => i.id === "settings:control:language")
    expect(control).toBe(0)
  })

  /**
   * The other half of the same bug. `matchTitles` cut to `limit` on the raw
   * score, so at the cut line a tied control took the last slot from the very
   * section it was supposed to yield to, and the penalty never got a say in
   * which rows survived.
   */
  it("spends a tight limit on the sections a tied control should yield to", async () => {
    const out = await settingsProvider.search(
      makeProviderInput("settings.", { ctx: ctxAll(), limit: 3 })
    )
    expect(out.items).toHaveLength(3)
    expect(out.items.every((i) => i.id.startsWith("settings:section:"))).toBe(true)
    // `total` still counts everything that matched, not what survived the cut.
    expect(out.total).toBe(SETTINGS_NAV.length + SETTING_CONTROLS.length)
    expect(out.truncated).toBe(true)
  })

  it("tolerates a control pointing at a section without a nav entry, and sections without keywords", () => {
    const ctx = makeTestContext({
      host: {
        reachableSettingsSections: new Set(["ghost", "appearance"]),
        recorderAvailable: false,
        theme: "light",
        hasApiKey: false,
        pluginQuickActions: [],
        workbenchPanels: [],
        canBrowseHostFolders: true,
      },
    })
    const rows = settingsCandidates(ctx, {
      nav: SETTINGS_NAV.filter((n) => n.id === "appearance"),
      controls: [
        { id: "orphan", sectionId: "ghost" as never, labelKey: "orphan" },
        { id: "lang", sectionId: "appearance", labelKey: "language", keywords: ["语言"] },
      ],
      keywords: {},
    })
    expect(rows.find((r) => r.id === "control:orphan")!.meta).toBe("settings.tabs.ghost")
    expect(rows.find((r) => r.id === "control:orphan")!.keywords).toEqual(["orphan"])
    expect(rows.find((r) => r.id === "control:lang")!.keywords).toEqual(["lang", "语言"])
    expect(rows.find((r) => r.id === "section:appearance")!.keywords).toEqual(["appearance"])
  })
})
