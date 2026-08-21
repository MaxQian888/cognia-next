/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useConversationFilterController } from "./use-conversation-filter-controller"
import {
  CONVERSATION_FILTER_UNASSIGNED,
  EMPTY_CONVERSATION_FILTERS,
} from "@/lib/chat/conversation-filters"
import { BUILT_IN_VIEW_IDS } from "@/lib/chat/conversation-views"
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
  it("starts unfiltered, in no view, with only the built-in views on offer", () => {
    const { result } = setup()
    expect(result.current.filters).toEqual(EMPTY_CONVERSATION_FILTERS)
    expect(result.current.activeFilters).toBe(0)
    expect(result.current.sortBy).toBe("recent")
    expect(result.current.groupBy).toBe("workspace")
    expect(result.current.search).toEqual({
      workspace: "current",
      includeArchived: false,
      content: false,
    })
    expect(result.current.views.every((view) => view.builtIn)).toBe(true)
    expect(result.current.activeView).toBeUndefined()
    expect(result.current.activeViewDrift).toEqual([])
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
    act(() => result.current.actions.applyView("p1"))
    expect(trackConversationFiltered).toHaveBeenCalledWith("view", 2)
    act(() => result.current.actions.applyView("missing"))
    expect(trackConversationFiltered).toHaveBeenCalledTimes(1)
  })

  it("routes sort through the sidebar-settings save", () => {
    const { result, saveSidebarSettings } = setup()
    act(() => result.current.actions.setSortBy("title"))
    expect(saveSidebarSettings).toHaveBeenCalledWith({ sortBy: "title" })
  })

  it("saves the current state as a view and reports it back as active", () => {
    const { result, saveSidebarSettings, rerender } = setup()
    act(() => result.current.actions.toggle("pinned", true))
    let id: string | null = null
    act(() => {
      id = result.current.actions.saveView("  Pinned only ", ["filters"])
    })
    expect(id).toBe("id-1")
    expect(saveSidebarSettings).toHaveBeenCalledWith({
      views: [
        {
          id: "id-1",
          name: "Pinned only",
          createdAt: expect.any(Number),
          filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
        },
      ],
    })
    // The settings store echoes the write back through props.
    const saved = saveSidebarSettings.mock.calls[0][0] as ConversationSidebarSettings
    rerender({ sidebarSettings: saved })
    expect(result.current.views.filter((view) => !view.builtIn)).toHaveLength(1)
    expect(result.current.activeView?.id).toBe("id-1")
    expect(result.current.activeViewDrift).toEqual([])
  })

  it("pins only the ticked dimensions", () => {
    const { result, saveSidebarSettings } = setup({ sortBy: "title", groupBy: "agent" })
    act(() => {
      result.current.actions.saveView("Alphabetical", ["sortBy"])
    })
    expect(saveSidebarSettings).toHaveBeenCalledWith({
      views: [expect.objectContaining({ sortBy: "title" })],
    })
    const stored = (saveSidebarSettings.mock.calls[0][0] as ConversationSidebarSettings).views![0]!
    expect(stored.groupBy).toBeUndefined()
    expect(stored.filters).toBeUndefined()
  })

  it("refuses a blank name or a view that pins nothing", () => {
    const { result, saveSidebarSettings } = setup()
    let id: string | null = "x"
    act(() => {
      // Nothing narrows, so "filters" has nothing to pin.
      id = result.current.actions.saveView("Nothing", ["filters"])
    })
    expect(id).toBeNull()
    act(() => result.current.actions.toggle("unread", true))
    act(() => {
      id = result.current.actions.saveView("   ", ["filters"])
    })
    expect(id).toBeNull()
    expect(saveSidebarSettings).not.toHaveBeenCalled()
  })

  it("applies a view over both persistence faces, touching only what it pins", () => {
    const { result, saveSidebarSettings } = setup({
      views: [
        {
          id: "v1",
          name: "Unread first",
          createdAt: 1,
          filters: { unread: true },
          sortBy: "unread",
        },
        { id: "v2", name: "By agent", createdAt: 2, groupBy: "agent" },
      ],
    })
    act(() => result.current.actions.applyView("v1"))
    expect(useUIStore.getState().conversationFilters.unread).toBe(true)
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({ sortBy: "unread" })

    // v2 says nothing about filters, so the ones on screen survive — otherwise
    // every grouping-only view would double as a filter reset.
    act(() => result.current.actions.applyView("v2"))
    expect(useUIStore.getState().conversationFilters.unread).toBe(true)
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({ groupBy: "agent" })
  })

  it("reports drift on the view's own dimensions, and only those", () => {
    const { result, rerender } = setup({
      sortBy: "unread",
      groupBy: "workspace",
      views: [{ id: "v1", name: "Unread first", createdAt: 1, sortBy: "unread" }],
    })
    act(() => result.current.actions.applyView("v1"))
    expect(result.current.activeViewDrift).toEqual([])
    // Grouping is not this view's claim.
    rerender({
      sidebarSettings: {
        sortBy: "unread",
        groupBy: "agent",
        views: [{ id: "v1", name: "Unread first", createdAt: 1, sortBy: "unread" }],
      },
    })
    expect(result.current.activeViewDrift).toEqual([])
    // Sort is.
    rerender({
      sidebarSettings: {
        sortBy: "title",
        groupBy: "agent",
        views: [{ id: "v1", name: "Unread first", createdAt: 1, sortBy: "unread" }],
      },
    })
    expect(result.current.activeViewDrift).toEqual(["sortBy"])
  })

  it("re-captures exactly the dimensions a view already claims when updating it", () => {
    const views = [{ id: "v1", name: "Unread first", createdAt: 1, sortBy: "unread" as const }]
    const { result, saveSidebarSettings } = setup({ sortBy: "title", groupBy: "agent", views })
    act(() => result.current.actions.updateView("v1"))
    const stored = (saveSidebarSettings.mock.calls.at(-1)![0] as ConversationSidebarSettings)
      .views![0]!
    expect(stored.sortBy).toBe("title")
    // Updating "unread first" must not quietly start pinning the grouping too.
    expect(stored.groupBy).toBeUndefined()
  })

  it("puts every pinned dimension back on revert", () => {
    const views = [
      {
        id: "v1",
        name: "Unread first",
        createdAt: 1,
        filters: { unread: true },
        sortBy: "unread" as const,
      },
    ]
    const { result, saveSidebarSettings } = setup({ sortBy: "title", views })
    act(() => result.current.actions.applyView("v1"))
    act(() => result.current.actions.toggle("unread", false))
    act(() => result.current.actions.revertView())
    expect(useUIStore.getState().conversationFilters.unread).toBe(true)
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({ sortBy: "unread" })
  })

  it("leaves a view without changing what is on screen", () => {
    const views = [{ id: "v1", name: "Unread first", createdAt: 1, filters: { unread: true } }]
    const { result } = setup({ views })
    act(() => result.current.actions.applyView("v1"))
    act(() => result.current.actions.clearView())
    expect(result.current.activeView).toBeUndefined()
    expect(useUIStore.getState().conversationFilters.unread).toBe(true)
  })

  it("renames and deletes custom views", () => {
    const views = [
      { id: "v1", name: "Unread", createdAt: 1, filters: { unread: true } },
      { id: "v2", name: "Teams", createdAt: 2, filters: { kind: "team" as const } },
    ]
    const { result, saveSidebarSettings } = setup({ views })
    act(() => result.current.actions.renameView("v1", "Unread chats"))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      views: [
        expect.objectContaining({ id: "v1", name: "Unread chats" }),
        expect.objectContaining({ id: "v2" }),
      ],
    })
    act(() => result.current.actions.removeView("v1"))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      views: [expect.objectContaining({ id: "v2" })],
    })
  })

  it("hides a built-in view instead of deleting it, and can restore it", () => {
    // Built-ins are code, not data: deleting one would have nothing to delete.
    const { result, saveSidebarSettings } = setup()
    act(() => result.current.actions.removeView(BUILT_IN_VIEW_IDS.unread))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      hiddenViewIds: [BUILT_IN_VIEW_IDS.unread],
    })
    act(() => result.current.actions.restoreView(BUILT_IN_VIEW_IDS.unread))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({ hiddenViewIds: [] })
  })

  it("leaves the view when the one you are in is removed", () => {
    const views = [{ id: "v1", name: "Unread", createdAt: 1, filters: { unread: true } }]
    const { result } = setup({ views })
    act(() => result.current.actions.applyView("v1"))
    act(() => result.current.actions.removeView("v1"))
    expect(useUIStore.getState().activeConversationViewId).toBeNull()
  })

  it("merges one search axis at a time so flipping one never drops the others", () => {
    const { result, saveSidebarSettings } = setup({
      search: { workspace: "all", includeArchived: true, content: false },
    })
    act(() => result.current.actions.setSearchOptions({ content: true }))
    expect(saveSidebarSettings).toHaveBeenLastCalledWith({
      search: { workspace: "all", includeArchived: true, content: true },
    })
  })

  it("routes grouping through the sidebar-settings save", () => {
    const { result, saveSidebarSettings } = setup()
    act(() => result.current.actions.setGroupBy("agent"))
    expect(saveSidebarSettings).toHaveBeenCalledWith({ groupBy: "agent" })
  })

  it("suggests the dimensions the user has actually moved", () => {
    expect(setup().result.current.suggestedViewDimensions).toEqual([])
    const { result } = setup({ sortBy: "title", search: { content: true } })
    expect(result.current.suggestedViewDimensions).toEqual(["sortBy", "search"])
  })
})
