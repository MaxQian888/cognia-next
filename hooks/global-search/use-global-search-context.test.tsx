/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const hasKey = jest.fn((key: string) => key.startsWith("plugin.known"))
// One stable translator, as next-intl memoises its own — the context hook's
// identity test below depends on it.
jest.mock("next-intl", () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  ;(t as { has?: (k: string) => boolean }).has = (key: string) => hasKey(key)
  const now = new Date(1_750_000_000_000)
  return { useTranslations: () => t, useLocale: () => "zh-CN", useNow: () => now }
})
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark" }) }))
let mockPlatform: "web" | "tauri" | "mobile" = "web"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
jest.mock("@/hooks/settings/use-settings-section-reachability", () => {
  const sections = new Set(["appearance"])
  return { useSettingsSectionReachability: () => ({ sections }) }
})
jest.mock("@/hooks/skills/use-skill-recorder", () => ({ useRecorderAvailable: () => true }))
const quickActions = [{ fullId: "p:a" }]
jest.mock("@/hooks/plugins/use-plugin-quick-actions", () => ({
  usePluginQuickActions: (surface: string) => (surface === "palette" ? quickActions : []),
}))
const panels: Array<{
  id: string
  labelKey: string
  label?: string
  pluginId?: string
  activity: string
}> = []
jest.mock("@/lib/context-workbench/active-context", () => ({
  getActiveWorkbenchPanels: () => panels.map((p) => ({ ...p })),
  getActiveContextRevision: () => 1,
  subscribeActiveContext: () => () => {},
}))
const projectState: {
  activeProjectId: string | null
  projects: Array<{ id: string; name: string }>
} = {
  activeProjectId: "p1",
  projects: [{ id: "p1", name: "One" }],
}
const chatSessionRef: { activeSessionId: string | null } = { activeSessionId: "s1" }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: typeof projectState) => unknown) => selector(projectState),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector(chatSessionRef),
}))
let mockPathname: string | null = "/"
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }))
// The layout hook's own resolution is covered by its spec; here only what the
// context makes of it. One stable object, as the hook memoises its own.
const sidebarLayout = {
  catalog: [
    { id: "inbox", route: "/inbox", i18nKey: "inbox" },
    { id: "source-control", route: "/source-control", i18nKey: "sourceControl" },
    { id: "logs", route: "/logs", i18nKey: "logs" },
  ],
  resolved: {
    pinned: [{ id: "inbox" }],
    overflow: [{ id: "source-control" }],
    hidden: [{ id: "logs" }],
  },
  side: "right" as "left" | "right",
}
jest.mock("@/components/shell/use-sidebar-layout", () => ({
  useSidebarLayout: () => sidebarLayout,
}))
const uiState = { guildRailCollapsed: false }
jest.mock("@/stores/ui", () => ({
  useUIStore: (selector: (s: typeof uiState) => unknown) => selector(uiState),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: { apiKey?: string } }) => unknown) =>
    selector({ settings: { apiKey: "sk" } }),
}))

import { resolvePanelLabel, useGlobalSearchContext } from "./use-global-search-context"

describe("useGlobalSearchContext", () => {
  beforeEach(() => {
    panels.length = 0
    mockPlatform = "web"
    mockPathname = "/"
    uiState.guildRailCollapsed = false
  })

  it("assembles the context from hooks and stores", () => {
    panels.push(
      { id: "files", labelKey: "contextWorkbench.files", activity: "explorer" },
      { id: "plugin:x", labelKey: "panel", label: "Raw", pluginId: "unknown", activity: "plugins" },
      { id: "plugin:y", labelKey: "panel", label: "Raw", pluginId: "known", activity: "plugins" }
    )
    const sessions = [{ id: "s1", title: "A" }] as ChatSession[]
    const { result } = renderHook(() => useGlobalSearchContext({ sessions, scope: "chats" }))
    const ctx = result.current
    expect(ctx.locale).toBe("zh-CN")
    expect(ctx.platform).toBe("web")
    expect(ctx.isTauri).toBe(false)
    expect(ctx.scope).toBe("chats")
    expect(ctx.sessions).toBe(sessions)
    expect(ctx.workspaces).toEqual(projectState.projects)
    expect(ctx.activeProjectId).toBe("p1")
    expect(ctx.activeSessionId).toBe("s1")
    expect(ctx.now).toBe(1_750_000_000_000)
    expect(ctx.t("a.b", { n: 1 })).toBe('a.b:{"n":1}')
    expect(ctx.host).toMatchObject({
      recorderAvailable: true,
      // A browser can never host the desktop pet (ADR-0058 D9).
      petHostAvailable: false,
      theme: "dark",
      hasApiKey: true,
      pluginQuickActions: quickActions,
    })
    expect(ctx.host.reachableSettingsSections.has("appearance")).toBe(true)
    expect(ctx.host.workbenchPanels).toEqual([
      { id: "files", label: "contextWorkbench.files", activity: "explorer" },
      { id: "plugin:x", label: "Raw", activity: "plugins" },
      { id: "plugin:y", label: "plugin.known.panel", activity: "plugins" },
    ])
  })

  it("lets the desktop main window host the pet, whatever the pet's own setting", () => {
    // Summoning switches the pet on, so only the host and window role count.
    mockPlatform = "tauri"
    const { result } = renderHook(() => useGlobalSearchContext({ sessions: [], scope: "all" }))
    expect(result.current.host.petHostAvailable).toBe(true)
  })

  it("keeps the pet actions away from the mobile shell", () => {
    mockPlatform = "mobile"
    const { result } = renderHook(() => useGlobalSearchContext({ sessions: [], scope: "all" }))
    expect(result.current.host.petHostAvailable).toBe(false)
  })

  describe("shellNav", () => {
    const shellNav = () =>
      renderHook(() => useGlobalSearchContext({ sessions: [], scope: "all" })).result.current.host
        .shellNav

    it("has no current page off every catalog route", () => {
      for (const path of ["/", "/settings", null]) {
        mockPathname = path
        expect(shellNav()).toMatchObject({
          currentPage: null,
          currentPinned: false,
          currentHidden: false,
        })
      }
    })

    it("resolves the route in front onto the catalog, pinned or not", () => {
      mockPathname = "/inbox/c"
      expect(shellNav()).toEqual({
        currentPage: { id: "inbox", i18nKey: "inbox" },
        currentPinned: true,
        currentHidden: false,
        railCollapsed: false,
        side: "right",
        railChrome: true,
      })
      mockPathname = "/source-control"
      expect(shellNav()).toMatchObject({
        currentPage: { id: "source-control", i18nKey: "sourceControl" },
        currentPinned: false,
        currentHidden: false,
      })
      mockPathname = "/logs"
      expect(shellNav()).toMatchObject({ currentPinned: false, currentHidden: true })
    })

    it("reads the rail's fold state and marks the mobile drawer as no rail chrome", () => {
      uiState.guildRailCollapsed = true
      expect(shellNav()).toMatchObject({ railCollapsed: true, railChrome: true })
      mockPlatform = "mobile"
      expect(shellNav().railChrome).toBe(false)
    })
  })

  it("keeps the context identity stable across re-renders with the same inputs", () => {
    const sessions = [] as ChatSession[]
    const { result, rerender } = renderHook(() =>
      useGlobalSearchContext({ sessions, scope: "all" })
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("resolvePanelLabel falls back to the raw label when the translator has no has()", () => {
    const t = ((key: string) => `T:${key}`) as never
    expect(resolvePanelLabel({ labelKey: "k" }, t)).toBe("T:k")
    expect(resolvePanelLabel({ labelKey: "k", pluginId: "p", label: "L" }, t)).toBe("L")
    expect(resolvePanelLabel({ labelKey: "k", pluginId: "p" }, t)).toBe("k")
  })

  it("normalises missing active ids to null", () => {
    projectState.activeProjectId = null
    chatSessionRef.activeSessionId = null
    try {
      const { result } = renderHook(() => useGlobalSearchContext({ sessions: [], scope: "all" }))
      expect(result.current.activeProjectId).toBeNull()
      expect(result.current.activeSessionId).toBeNull()
    } finally {
      projectState.activeProjectId = "p1"
      chatSessionRef.activeSessionId = "s1"
    }
  })
})
