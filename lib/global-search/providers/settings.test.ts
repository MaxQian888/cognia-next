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
