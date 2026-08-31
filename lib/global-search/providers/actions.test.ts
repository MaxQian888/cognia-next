import { makeProviderInput, makeTestContext } from "../testing"
import { actionCandidates, actionsProvider } from "./actions"

const hostDefaults: ReturnType<typeof makeTestContext>["host"] = {
  reachableSettingsSections: new Set(),
  recorderAvailable: false,
  theme: "light",
  hasApiKey: false,
  pluginQuickActions: [],
  workbenchPanels: [],
  canBrowseHostFolders: true,
}

const host = (over: Partial<ReturnType<typeof makeTestContext>["host"]> = {}) =>
  makeTestContext({ host: { ...hostDefaults, ...over } })

describe("actions provider", () => {
  it("gates the recorder entry and flips the theme label", () => {
    const base = actionCandidates(host())
    expect(base.some((c) => c.id === "open-recorder")).toBe(false)
    expect(base.find((c) => c.id === "toggle-theme")!.title).toBe(
      "globalSearch.actions.switchToDark"
    )
    const dark = actionCandidates(host({ recorderAvailable: true, theme: "dark", hasApiKey: true }))
    expect(dark.some((c) => c.id === "open-recorder")).toBe(true)
    expect(dark.find((c) => c.id === "toggle-theme")!.title).toBe(
      "globalSearch.actions.switchToLight"
    )
    expect(dark.find((c) => c.id === "manage-api-key")!.extra?.current).toBe(true)
  })

  it("marks desktop-only commands as disabled off Tauri", () => {
    const web = actionCandidates(makeTestContext({ isTauri: false, host: hostDefaults }))
    expect(web.find((c) => c.id === "check-updates")!.extra?.disabledReason).toBeDefined()
  })

  /**
   * Folder browsing is NOT a desktop-only command. A paired phone or browser
   * walks the host's filesystem through the same picker the workspace switcher
   * opens, so gating this on `isTauri` made the palette refuse what the
   * switcher offered, on the same device.
   */
  it("offers the folder picker wherever a folder can actually be chosen", () => {
    const paired = actionCandidates(
      makeTestContext({ isTauri: false, host: { ...hostDefaults, canBrowseHostFolders: true } })
    )
    expect(paired.find((c) => c.id === "open-folder")!.extra).toBeUndefined()

    const unpaired = actionCandidates(
      makeTestContext({ isTauri: false, host: { ...hostDefaults, canBrowseHostFolders: false } })
    )
    expect(unpaired.find((c) => c.id === "open-folder")!.extra?.disabledReason).toBe(
      "globalSearch.actions.openFolderNeedsHost"
    )
  })

  /**
   * The switcher footer's other three entries. They lived inside a Popover in
   * the desktop rail and a Drawer on `/`, so on any other mobile route a
   * workspace could not be created, adopted or managed at all.
   */
  it("carries the workspace editors the switcher footer owns", () => {
    const ids = actionCandidates(makeTestContext()).map((c) => c.id)
    expect(ids).toEqual(
      expect.arrayContaining(["new-workspace", "adopt-workspaces", "manage-workspace-roots"])
    )
  })

  it("matches by keyword (bilingual) and produces command actions", async () => {
    const zh = await actionsProvider.search(makeProviderInput("主题"))
    expect(zh.items[0]!.action).toEqual({ type: "command", id: "toggle-theme" })
    const en = await actionsProvider.search(makeProviderInput("markdown"))
    expect(en.items[0]!.id).toBe("action:export-markdown")
    const none = await actionsProvider.search(makeProviderInput("qqqqq"))
    expect(none.items).toEqual([])
  })

  it("boosts primary commands on equal matches", async () => {
    // Every title is its i18n key: search the shared prefix so all match equally.
    const out = await actionsProvider.search(
      makeProviderInput("globalSearch.actions.", { limit: 50 })
    )
    const ids = out.items.map((i) => i.id)
    expect(ids.indexOf("action:new-chat")).toBeLessThan(ids.indexOf("action:toggle-sidebar"))
    expect(out.items[0]!.score).toBeLessThanOrEqual(1)
  })

  it("suggests only primary commands", async () => {
    const items = await actionsProvider.suggest!({
      ctx: host(),
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual([
      "action:new-chat",
      "action:toggle-theme",
      "action:open-settings",
    ])
    expect(items[0]!.subtitle).toBe("globalSearch.actions.newChatHint")
  })
})
