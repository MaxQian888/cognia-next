import { makeProviderInput, makeTestContext } from "../testing"
import { actionCandidates, actionsProvider } from "./actions"

const host = (over: Partial<ReturnType<typeof makeTestContext>["host"]> = {}) =>
  makeTestContext({
    host: {
      reachableSettingsSections: new Set(),
      recorderAvailable: false,
      theme: "light",
      hasApiKey: false,
      pluginQuickActions: [],
      workbenchPanels: [],
      ...over,
    },
  })

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
    const web = actionCandidates(makeTestContext({ isTauri: false }))
    expect(web.find((c) => c.id === "open-folder")!.extra?.disabledReason).toBe(
      "globalSearch.actions.desktopOnly"
    )
    expect(web.find((c) => c.id === "check-updates")!.extra?.disabledReason).toBeDefined()
    const desktop = actionCandidates(makeTestContext({ isTauri: true }))
    expect(desktop.find((c) => c.id === "open-folder")!.extra).toBeUndefined()
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
