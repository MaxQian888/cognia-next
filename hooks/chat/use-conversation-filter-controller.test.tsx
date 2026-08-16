/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useConversationFilterController } from "./use-conversation-filter-controller"
import {
  CONVERSATION_FILTER_UNASSIGNED,
  EMPTY_CONVERSATION_FILTERS,
} from "@/lib/chat/conversation-filters"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useUIStore } from "@/stores/ui"
import type {
  Character,
  ChatSession,
  ConversationSidebarSettings,
} from "@cognia/agent-config-types"

jest.mock("nanoid", () => {
  let n = 0
  return { nanoid: () => `id-${++n}` }
})

jest.mock("@/lib/ai/icons", () => ({
  getModelDisplayName: (id: string) => `Model ${id}`,
  getProviderDisplayName: (id: string) => `Provider ${id}`,
}))

jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationFiltered: jest.fn(() => Promise.resolve(true)),
}))
import { trackConversationFiltered } from "@/lib/telemetry/conversation-list-events"

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt: 1, ...overrides } as ChatSession
}

const characters = [
  { id: "c1", name: "Alice", model: "claude-a", providerId: "anthropic" },
  { id: "c2", name: "Bob" },
] as Character[]

const sessions = [
  session("s1", { projectId: "w1", characterId: "c1" }),
  session("s2", { projectId: "w1", characterId: "c2", model: "gpt", providerOverride: "openai" }),
  session("s3", { kind: "team", teamId: "t1" }),
]

function setup(settings: ConversationSidebarSettings = {}) {
  const saveSidebarSettings = jest.fn()
  const hook = renderHook(
    (props: { sidebarSettings: ConversationSidebarSettings }) =>
      useConversationFilterController({
        sessions,
        workspaces: [{ id: "w1", name: "Alpha" }],
        folders: [],
        characters,
        teams: [{ id: "t1", name: "Squad" }],
        sidebarSettings: props.sidebarSettings,
        saveSidebarSettings,
      }),
    { initialProps: { sidebarSettings: settings } }
  )
  return { ...hook, saveSidebarSettings }
}

beforeEach(() => {
  jest.mocked(trackConversationFiltered).mockClear()
  useUIStore.getState().resetConversationFilters()
  useSettingsStore.setState({
    settings: { defaultModel: "default-model", defaultProvider: "default-provider" } as never,
  })
})

describe("useConversationFilterController", () => {
  it("starts unfiltered with recency sort and no presets", () => {
    const { result } = setup()
    expect(result.current.filters).toEqual(EMPTY_CONVERSATION_FILTERS)
    expect(result.current.activeFilters).toBe(0)
    expect(result.current.sortBy).toBe("recent")
    expect(result.current.presets).toEqual([])
    expect(result.current.activePreset).toBeUndefined()
  })

  it("derives option candidates from the sessions with the character / default fallback", () => {
    const { result } = setup()
    expect(result.current.options.workspaceIds).toEqual([
      { value: "w1", label: "Alpha", count: 2 },
      { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
    ])
    expect(result.current.options.agentIds.map((o) => [o.value, o.count])).toEqual([
      ["c1", 1],
      ["c2", 1],
    ])
    expect(result.current.options.teamIds).toEqual([{ value: "t1", label: "Squad", count: 1 }])
    // s1 → character model, s2 → row model, s3 → profile default.
    expect(result.current.options.models.map((o) => [o.value, o.label, o.count])).toEqual([
      ["claude-a", "Model claude-a", 1],
      ["default-model", "Model default-model", 1],
      ["gpt", "Model gpt", 1],
    ])
    expect(result.current.options.providers.map((o) => o.value).sort()).toEqual([
      "anthropic",
      "default-provider",
      "openai",
    ])
  })

  it("exposes the same fallback chain as filterContext for the list model", () => {
    const { result } = setup()
    expect(result.current.filterContext.modelOf?.(sessions[0])).toBe("claude-a")
    expect(result.current.filterContext.modelOf?.(sessions[2])).toBe("default-model")
    expect(result.current.filterContext.providerOf?.(sessions[1])).toBe("openai")
    expect(result.current.filterContext.providerOf?.(sessions[2])).toBe("default-provider")
  })

  it("writes every filter action into the UI store", () => {
    const { result } = setup()
    act(() => result.current.actions.toggle("unread", true))
    act(() => result.current.actions.setKind("team"))
    act(() => result.current.actions.toggleValue("workspaceIds", "w1", true))
    act(() => result.current.actions.setList("models", ["gpt", "gpt"]))
    act(() => result.current.actions.setActivity("week"))
    expect(useUIStore.getState().conversationFilters).toEqual({
      ...EMPTY_CONVERSATION_FILTERS,
      unread: true,
      kind: "team",
      workspaceIds: ["w1"],
      models: ["gpt"],
      activity: "week",
    })
    expect(result.current.activeFilters).toBe(5)
    act(() => result.current.actions.reset())
    expect(result.current.filters).toEqual(EMPTY_CONVERSATION_FILTERS)
  })

  it("reports each filter change by facet and the resulting active count — never a value", () => {
    const { result } = setup()
    act(() => result.current.actions.toggle("unread", true))
    act(() => result.current.actions.setKind("team"))
    act(() => result.current.actions.toggleValue("workspaceIds", "w1", true))
    act(() => result.current.actions.setList("models", ["gpt"]))
    act(() => result.current.actions.setActivity("week"))
    act(() => result.current.actions.reset())
    expect(jest.mocked(trackConversationFiltered).mock.calls).toEqual([
      ["unread", 1],
      ["kind", 2],
      ["workspaceIds", 3],
      ["models", 4],
      ["activity", 5],
      ["reset", 0],
    ])
    expect(JSON.stringify(jest.mocked(trackConversationFiltered).mock.calls)).not.toContain("w1")
  })

  it("reports a preset application as one filter change", () => {
    const { result } = setup({
      filterPresets: [
        {
          id: "p1",
          name: "Unread",
          filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true },
          createdAt: 1,
        },
      ],
    })
    act(() => result.current.actions.applyPreset("p1"))
    expect(trackConversationFiltered).toHaveBeenCalledWith("preset", 2)
    act(() => result.current.actions.applyPreset("missing"))
    expect(trackConversationFiltered).toHaveBeenCalledTimes(1)
  })

  it("routes sort through the sidebar-settings save", () => {
    const { result, saveSidebarSettings } = setup()
    act(() => result.current.actions.setSortBy("title"))
    expect(saveSidebarSettings).toHaveBeenCalledWith({ sortBy: "title" })
  })

  it("saves the active filters as a preset and reports the matching preset back", () => {
    const { result, saveSidebarSettings, rerender } = setup()
    act(() => result.current.actions.toggle("pinned", true))
    let id: string | null = null
    act(() => {
      id = result.current.actions.savePreset("  Pinned only ")
    })
    expect(id).toBe("id-1")
    expect(saveSidebarSettings).toHaveBeenCalledWith({
      filterPresets: [
        {
          id: "id-1",
          name: "Pinned only",
          filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
          createdAt: expect.any(Number),
        },
      ],
    })
    // The settings store echoes the write back through props.
    const saved = saveSidebarSettings.mock.calls[0][0] as ConversationSidebarSettings
    rerender({ sidebarSettings: saved })
    expect(result.current.presets).toHaveLength(1)
    expect(result.current.activePreset?.id).toBe("id-1")
  })

  it("refuses to save an empty-name or unfiltered preset", () => {
    const { result, saveSidebarSettings } = setup()
    let id: string | null = "x"
    act(() => {
      id = result.current.actions.savePreset("Nothing")
    })
    expect(id).toBeNull()
    act(() => result.current.actions.toggle("unread", true))
    act(() => {
      id = result.current.actions.savePreset("   ")
    })
    expect(id).toBeNull()
    expect(saveSidebarSettings).not.toHaveBeenCalled()
  })

  it("applies, renames and deletes presets", () => {
    const presets = [
      { id: "p1", name: "Unread", filters: { unread: true }, createdAt: 1 },
      { id: "p2", name: "Teams", filters: { kind: "team" as const }, createdAt: 2 },
    ]
    const { result, saveSidebarSettings } = setup({ filterPresets: presets })
    expect(result.current.presets.map((p) => p.id)).toEqual(["p1", "p2"])
    act(() => result.current.actions.applyPreset("p2"))
    expect(useUIStore.getState().conversationFilters.kind).toBe("team")
    expect(result.current.activePreset?.id).toBe("p2")
    act(() => result.current.actions.applyPreset("missing"))
    expect(useUIStore.getState().conversationFilters.kind).toBe("team")

    act(() => result.current.actions.renamePreset("p1", "Unread chats"))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      filterPresets: [
        expect.objectContaining({ id: "p1", name: "Unread chats" }),
        expect.objectContaining({ id: "p2" }),
      ],
    })
    act(() => result.current.actions.deletePreset("p1"))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      filterPresets: [expect.objectContaining({ id: "p2" })],
    })
  })
})
