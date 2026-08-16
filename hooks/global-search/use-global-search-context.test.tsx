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
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "web" }))
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
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: { apiKey?: string } }) => unknown) =>
    selector({ settings: { apiKey: "sk" } }),
}))

import { resolvePanelLabel, useGlobalSearchContext } from "./use-global-search-context"

describe("useGlobalSearchContext", () => {
  beforeEach(() => {
    panels.length = 0
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
