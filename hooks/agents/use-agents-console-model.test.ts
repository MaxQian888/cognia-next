/**
 * @jest-environment jsdom
 */

// A live query that really runs its querier (async), so the hook's
// "undefined while the first read is in flight" state is exercised.
jest.mock("dexie-react-hooks", () => {
  const { useEffect, useState } = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: (querier: () => unknown, deps: unknown[]) => {
      const [value, setValue] = useState<unknown>(undefined)
      useEffect(() => {
        let cancelled = false
        void Promise.resolve(querier()).then((result) => {
          if (!cancelled) setValue(result)
        })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

jest.mock("@/lib/db/characters", () => ({ listResolvedCharacters: jest.fn() }))
jest.mock("@/lib/agents/agent-source", () => ({ countPendingPackUpdates: jest.fn() }))
jest.mock("./use-agent-activity", () => ({ useAgentSummaries: jest.fn() }))
jest.mock("./use-agent-catalogs", () => ({ useAgentCatalogs: jest.fn() }))
jest.mock("./use-start-agent-chat", () => ({ useStartAgentChat: jest.fn() }))

import { renderHook, waitFor } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"
import type { AgentSummary } from "@/lib/agents/agent-activity"
import { countPendingPackUpdates } from "@/lib/agents/agent-source"
import { listResolvedCharacters } from "@/lib/db/characters"
import { useAgentSummaries } from "./use-agent-activity"
import { useAgentCatalogs } from "./use-agent-catalogs"
import { useAgentsConsoleModel } from "./use-agents-console-model"
import type { AgentsRouteState, AgentsView } from "./use-agents-route-state"
import { useStartAgentChat } from "./use-start-agent-chat"

const listMock = listResolvedCharacters as jest.Mock
const pendingMock = countPendingPackUpdates as jest.Mock
const summariesMock = useAgentSummaries as jest.Mock
const catalogsMock = useAgentCatalogs as jest.Mock
const startChatMock = useStartAgentChat as jest.Mock

const CATALOGS = { skills: [], mcpServers: [], knowledgeBases: [] }
const start = jest.fn(async () => undefined)

function agent(id: string, patch: Partial<Character> = {}): Character {
  return {
    id,
    name: id,
    systemPrompt: "",
    avatarColor: "#000",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function summary(status: AgentSummary["status"]): AgentSummary {
  return { status, turns: 0, conversations: 0 }
}

function route(view: AgentsView): AgentsRouteState {
  const noop = () => {}
  return {
    view,
    query: "",
    source: "all",
    sort: "recent",
    openList: noop,
    openAgent: noop,
    setMode: noop,
    openCreate: noop,
    openBuilder: noop,
    setQuery: noop,
    setSource: noop,
    setSort: noop,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  listMock.mockResolvedValue([])
  pendingMock.mockReturnValue(new Map())
  summariesMock.mockReturnValue(new Map())
  catalogsMock.mockReturnValue(CATALOGS)
  startChatMock.mockReturnValue({ start, starting: false })
})

describe("useAgentsConsoleModel", () => {
  it("is loading until the first agents read lands", () => {
    listMock.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "a", mode: "overview" }))
    )
    expect(result.current.agents).toBeUndefined()
    expect(result.current.selected).toBeUndefined()
    expect(result.current.selectedSiblingPending).toBe(0)
    expect(summariesMock).toHaveBeenLastCalledWith([])
    expect(pendingMock).toHaveBeenLastCalledWith([])
  })

  it("exposes the resolved agents and asks for their summaries by id", async () => {
    const agents = [agent("a"), agent("b")]
    listMock.mockResolvedValue(agents)
    const { result } = renderHook(() => useAgentsConsoleModel(route({ kind: "list" })))
    await waitFor(() => expect(result.current.agents).toEqual(agents))
    expect(summariesMock).toHaveBeenLastCalledWith(["a", "b"])
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it("passes the catalogs and the chat action through", async () => {
    startChatMock.mockReturnValue({ start, starting: true })
    const { result } = renderHook(() => useAgentsConsoleModel(route({ kind: "list" })))
    await waitFor(() => expect(result.current.agents).toEqual([]))
    expect(result.current.catalogs).toBe(CATALOGS)
    expect(result.current.startChat).toBe(start)
    expect(result.current.startingChat).toBe(true)
  })

  it("counts agents that are not idle as live", async () => {
    const summaries = new Map([
      ["a", summary("idle")],
      ["b", summary("running")],
      ["c", summary("awaiting")],
    ])
    summariesMock.mockReturnValue(summaries)
    const { result } = renderHook(() => useAgentsConsoleModel(route({ kind: "list" })))
    await waitFor(() => expect(result.current.agents).toEqual([]))
    expect(result.current.summaries).toBe(summaries)
    expect(result.current.liveCount).toBe(2)
  })

  it("selects nothing outside a detail view", async () => {
    listMock.mockResolvedValue([agent("a")])
    const { result } = renderHook(() => useAgentsConsoleModel(route({ kind: "create", mode: "1" })))
    await waitFor(() => expect(result.current.agents).toHaveLength(1))
    expect(result.current.selected).toBeNull()
  })

  it("selects the agent the URL names", async () => {
    const b = agent("b")
    listMock.mockResolvedValue([agent("a"), b])
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "b", mode: "edit" }))
    )
    await waitFor(() => expect(result.current.selected).toBe(b))
  })

  it("is null when the URL names an agent that does not exist", async () => {
    listMock.mockResolvedValue([agent("a")])
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "ghost", mode: "overview" }))
    )
    await waitFor(() => expect(result.current.agents).toHaveLength(1))
    expect(result.current.selected).toBeNull()
  })

  it("reports the pending pack updates for the selected agent's pack", async () => {
    const packed = agent("p", { sourcePluginId: "plug", sourcePackId: "pack" })
    listMock.mockResolvedValue([packed, agent("x")])
    pendingMock.mockReturnValue(
      new Map([
        ["plug:pack", 3],
        ["other:pack", 9],
      ])
    )
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "p", mode: "overview" }))
    )
    await waitFor(() => expect(result.current.selectedSiblingPending).toBe(3))
    expect(pendingMock).toHaveBeenLastCalledWith([packed, agent("x")])
  })

  it("is zero when the selected pack has no pending updates", async () => {
    listMock.mockResolvedValue([agent("p", { sourcePluginId: "plug", sourcePackId: "pack" })])
    pendingMock.mockReturnValue(new Map([["other:pack", 2]]))
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "p", mode: "overview" }))
    )
    await waitFor(() => expect(result.current.selected?.id).toBe("p"))
    expect(result.current.selectedSiblingPending).toBe(0)
  })

  it("is zero for a selected agent that is not from a pack", async () => {
    listMock.mockResolvedValue([agent("u", { sourcePluginId: "plug" })])
    pendingMock.mockReturnValue(new Map([["plug:undefined", 5]]))
    const { result } = renderHook(() =>
      useAgentsConsoleModel(route({ kind: "detail", id: "u", mode: "overview" }))
    )
    await waitFor(() => expect(result.current.selected?.id).toBe("u"))
    expect(result.current.selectedSiblingPending).toBe(0)
  })
})
