/**
 * @jest-environment jsdom
 */

// A live query that really runs its querier (async) and re-runs when the
// dependency list changes, so the hooks' Dexie reads are exercised.
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

let runStatus: ReadonlyMap<string, string> = new Map()
jest.mock("@/hooks/chat/use-session-run-status-map", () => ({
  useSessionRunStatusMap: () => runStatus,
}))

jest.mock("@/lib/db/agent-tasks", () => ({ listAgentTasks: jest.fn() }))
jest.mock("@/lib/db/agent-activity", () => ({
  listAgentSessions: jest.fn(),
  listAgentIssues: jest.fn(),
  listAgentsSummaryInputs: jest.fn(),
  listAgentUsageSince: jest.fn(),
}))
jest.mock("@/lib/agents/agent-activity", () => ({
  ...jest.requireActual("@/lib/agents/agent-activity"),
  deriveAgentActivity: jest.fn(),
  summarizeAgents: jest.fn(),
}))

import { renderHook, waitFor } from "@testing-library/react"
import { listAgentTasks } from "@/lib/db/agent-tasks"
import {
  listAgentIssues,
  listAgentSessions,
  listAgentsSummaryInputs,
  listAgentUsageSince,
} from "@/lib/db/agent-activity"
import {
  ACTIVITY_WINDOW_MS,
  deriveAgentActivity,
  summarizeAgents,
} from "@/lib/agents/agent-activity"
import { useAgentActivity, useAgentSummaries } from "./use-agent-activity"

const listTasks = listAgentTasks as jest.Mock
const listSessions = listAgentSessions as jest.Mock
const listIssues = listAgentIssues as jest.Mock
const listUsage = listAgentUsageSince as jest.Mock
const listSummaryInputs = listAgentsSummaryInputs as jest.Mock
const derive = deriveAgentActivity as jest.Mock
const summarize = summarizeAgents as jest.Mock

const NOW = 1_800_000_000_000

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, "now").mockReturnValue(NOW)
  runStatus = new Map()
  listSessions.mockResolvedValue([{ id: "s1" }])
  listTasks.mockResolvedValue([{ id: "t1" }])
  listIssues.mockResolvedValue([{ id: "i1" }])
  listUsage.mockResolvedValue([{ at: 1 }])
  derive.mockImplementation(() => ({ derived: true }))
  listSummaryInputs.mockResolvedValue({ sessions: [{ id: "s1" }], usage: [{ at: 2 }] })
  summarize.mockImplementation(() => new Map([["a1", { status: "idle" }]]))
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("useAgentActivity", () => {
  it("returns undefined without an agent id and reads nothing", async () => {
    const { result } = renderHook(() => useAgentActivity(undefined))
    await Promise.resolve()
    await Promise.resolve()
    expect(result.current).toBeUndefined()
    expect(listSessions).not.toHaveBeenCalled()
    expect(listTasks).not.toHaveBeenCalled()
    expect(listIssues).not.toHaveBeenCalled()
    expect(listUsage).not.toHaveBeenCalled()
    expect(derive).not.toHaveBeenCalled()
  })

  it("returns undefined for an empty-string id as well", async () => {
    const { result } = renderHook(() => useAgentActivity(""))
    await Promise.resolve()
    await Promise.resolve()
    expect(result.current).toBeUndefined()
    expect(listSessions).not.toHaveBeenCalled()
  })

  it("is undefined while the first read is in flight", () => {
    listSessions.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAgentActivity("a1"))
    expect(result.current).toBeUndefined()
    expect(derive).not.toHaveBeenCalled()
  })

  it("reads all four sources for the agent, usage bounded by the activity window", async () => {
    renderHook(() => useAgentActivity("a1"))
    await waitFor(() => expect(derive).toHaveBeenCalled())
    expect(listSessions).toHaveBeenCalledWith("a1")
    expect(listTasks).toHaveBeenCalledWith("a1")
    expect(listIssues).toHaveBeenCalledWith("a1")
    expect(listUsage).toHaveBeenCalledWith("a1", NOW - ACTIVITY_WINDOW_MS)
  })

  it("derives activity from the rows with recentLimit 50 and the live run status", async () => {
    runStatus = new Map([["s1", "streaming"]])
    const { result } = renderHook(() => useAgentActivity("a1"))
    await waitFor(() => expect(result.current).toEqual({ derived: true }))
    expect(derive).toHaveBeenCalledWith({
      sessions: [{ id: "s1" }],
      tasks: [{ id: "t1" }],
      issues: [{ id: "i1" }],
      usage: [{ at: 1 }],
      now: NOW,
      runStatus,
      recentLimit: 50,
    })
  })

  it("re-derives when the run status changes, without re-reading Dexie", async () => {
    const { result, rerender } = renderHook(() => useAgentActivity("a1"))
    await waitFor(() => expect(result.current).toBeDefined())
    derive.mockClear()
    listSessions.mockClear()
    runStatus = new Map([["s1", "awaiting_approval"]])
    rerender()
    expect(derive).toHaveBeenCalledTimes(1)
    expect(derive.mock.calls[0][0].runStatus).toBe(runStatus)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it("keeps the derived object stable across rerenders with unchanged inputs", async () => {
    derive.mockImplementation(() => ({ derived: true }))
    const { result, rerender } = renderHook(() => useAgentActivity("a1"))
    await waitFor(() => expect(result.current).toBeDefined())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(derive).toHaveBeenCalledTimes(1)
  })

  it("re-reads when the agent id changes", async () => {
    const { rerender } = renderHook(({ id }) => useAgentActivity(id), {
      initialProps: { id: "a1" as string | undefined },
    })
    await waitFor(() => expect(listSessions).toHaveBeenCalledWith("a1"))
    rerender({ id: "a2" })
    await waitFor(() => expect(listSessions).toHaveBeenCalledWith("a2"))
    expect(listUsage).toHaveBeenLastCalledWith("a2", NOW - ACTIVITY_WINDOW_MS)
  })

  it("goes back to undefined once the id is cleared", async () => {
    const { result, rerender } = renderHook(({ id }) => useAgentActivity(id), {
      initialProps: { id: "a1" as string | undefined },
    })
    await waitFor(() => expect(result.current).toBeDefined())
    rerender({ id: undefined })
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})

describe("useAgentSummaries", () => {
  it("returns an empty map until the summary inputs load", () => {
    listSummaryInputs.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAgentSummaries(["a1"]))
    expect(result.current.size).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
  })

  it("reads the summary inputs bounded by the activity window", async () => {
    renderHook(() => useAgentSummaries(["a1"]))
    await waitFor(() => expect(summarize).toHaveBeenCalled())
    expect(listSummaryInputs).toHaveBeenCalledWith(NOW - ACTIVITY_WINDOW_MS)
  })

  it("summarizes the requested ids with the rows, run status and read time", async () => {
    runStatus = new Map([["s1", "streaming"]])
    const { result } = renderHook(() => useAgentSummaries(["a1", "a2"]))
    await waitFor(() => expect(result.current.get("a1")).toEqual({ status: "idle" }))
    expect(summarize).toHaveBeenCalledWith(
      ["a1", "a2"],
      [{ id: "s1" }],
      [{ at: 2 }],
      runStatus,
      NOW
    )
  })

  it("passes an empty id list through as an empty array", async () => {
    renderHook(() => useAgentSummaries([]))
    await waitFor(() => expect(summarize).toHaveBeenCalled())
    expect(summarize.mock.calls[0][0]).toEqual([])
  })

  it("is keyed on the ids' content, not the array identity", async () => {
    const { result, rerender } = renderHook(({ ids }) => useAgentSummaries(ids), {
      initialProps: { ids: ["a1", "a2"] },
    })
    await waitFor(() => expect(result.current.size).toBe(1))
    const first = result.current
    summarize.mockClear()
    rerender({ ids: ["a1", "a2"] })
    expect(result.current).toBe(first)
    expect(summarize).not.toHaveBeenCalled()
  })

  it("recomputes (without re-reading) when the ids change", async () => {
    const { result, rerender } = renderHook(({ ids }) => useAgentSummaries(ids), {
      initialProps: { ids: ["a1"] },
    })
    await waitFor(() => expect(result.current.size).toBe(1))
    summarize.mockClear()
    listSummaryInputs.mockClear()
    rerender({ ids: ["a1", "a3"] })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][0]).toEqual(["a1", "a3"])
    expect(listSummaryInputs).not.toHaveBeenCalled()
  })

  it("recomputes when the run status changes", async () => {
    const { result, rerender } = renderHook(() => useAgentSummaries(["a1"]))
    await waitFor(() => expect(result.current.size).toBe(1))
    summarize.mockClear()
    runStatus = new Map([["s1", "streaming"]])
    rerender()
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][3]).toBe(runStatus)
  })
})
