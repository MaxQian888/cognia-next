/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

interface FakeAdapter {
  id: string
  writable: boolean
  parse: jest.Mock
}

const adapters: FakeAdapter[] = []

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const readAgentConfigMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  readAgentConfig: (id: string) => readAgentConfigMock(id),
}))

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

const listMcpServersMock = jest.fn()
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: () => listMcpServersMock(),
}))

jest.mock("@/lib/claude/agents", () => ({
  get MCP_AGENT_ADAPTERS() {
    return adapters
  },
}))

import {
  useAgentStatuses,
  refreshAgentStatuses,
  getDetectedWritableAgents,
} from "./use-agent-status"

beforeEach(() => {
  adapters.length = 0
  isTauriMock.mockReturnValue(true)
  readAgentConfigMock.mockReset()
  liveQueryMock.mockReset()
  listMcpServersMock.mockReset()
  // Reset the module-level snapshot cache between tests by forcing a refresh.
  refreshAgentStatuses()
})

function makeAdapter(
  id: string,
  writable = true,
  drafts: Array<{ name: string }> = []
): FakeAdapter {
  return {
    id,
    writable,
    parse: jest.fn(() => drafts),
  }
}

describe("useAgentStatuses", () => {
  it("short-circuits to empty snapshots outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    adapters.push(makeAdapter("claude-code"), makeAdapter("cursor"))
    liveQueryMock.mockReturnValue([])
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.statuses.map((s) => s.agent.id)).toEqual(["claude-code", "cursor"])
    for (const s of result.current.statuses) {
      expect(s.path).toBeNull()
      expect(s.exists).toBe(false)
      expect(s.inFileCount).toBe(0)
    }
    expect(readAgentConfigMock).not.toHaveBeenCalled()
  })

  it("loads snapshots, projects servers, and computes drift", async () => {
    const claudeCode = makeAdapter("claude-code", true, [{ name: "alpha" }, { name: "extra" }])
    const cursor = makeAdapter("cursor", true, [{ name: "beta" }])
    adapters.push(claudeCode, cursor)
    readAgentConfigMock.mockImplementation(async (id: string) => ({
      path: `/etc/${id}.json`,
      exists: true,
      parsed: { servers: {} },
    }))
    liveQueryMock.mockReturnValue([
      {
        name: "alpha",
        appsEnabled: { "claude-code": true, cursor: false },
      },
      {
        name: "beta",
        appsEnabled: { cursor: true },
      },
      {
        name: "missing",
        appsEnabled: { "claude-code": true },
      },
    ])
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.projectedCount).toEqual({ "claude-code": 2, cursor: 1 })
    const claudeDrift = result.current.drift["claude-code"]
    expect(claudeDrift?.missing).toEqual(["missing"])
    expect(claudeDrift?.unmanaged).toEqual(["extra"])
    expect(result.current.drift.cursor?.missing).toEqual([])
  })

  it("captures parse errors per agent without crashing the rest", async () => {
    const ok = makeAdapter("claude-code", true, [{ name: "alpha" }])
    const broken = makeAdapter("cursor", true, [])
    adapters.push(ok, broken)
    readAgentConfigMock.mockImplementation(async (id: string) => {
      if (id === "cursor") throw new Error("boom")
      return { path: "/etc/claude-code.json", exists: true, parsed: { ok: true } }
    })
    liveQueryMock.mockReturnValue([])
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    const cursor = result.current.statuses.find((s) => s.agent.id === "cursor")
    expect(cursor?.parseError).toBe("boom")
    expect(cursor?.exists).toBe(false)
  })

  it("skips drift for non-writable agents and ones with parse errors", async () => {
    adapters.push(
      makeAdapter("read-only", false, [{ name: "gamma" }]),
      makeAdapter("broken", true, [])
    )
    readAgentConfigMock.mockImplementation(async (id: string) => {
      if (id === "broken") return { path: "/x", exists: true, parsed: null, parseError: "bad" }
      return { path: "/etc/read-only.json", exists: true, parsed: {} }
    })
    liveQueryMock.mockReturnValue([{ name: "gamma", appsEnabled: { "read-only": true } }])
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    const drift = result.current.drift as Record<string, unknown>
    expect(drift["read-only"]).toBeUndefined()
    expect(drift.broken).toBeUndefined()
  })

  it("refresh() reloads the snapshot cache", async () => {
    const adapter = makeAdapter("claude-code", true, [])
    adapters.push(adapter)
    let nthCall = 0
    readAgentConfigMock.mockImplementation(async () => {
      nthCall += 1
      return { path: "/etc/x.json", exists: nthCall > 1, parsed: {} }
    })
    liveQueryMock.mockReturnValue([])
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.statuses[0].exists).toBe(false)
    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => {
      expect(result.current.statuses[0].exists).toBe(true)
    })
  })

  it("falls back to empty server list when useLiveQuery is undefined", async () => {
    adapters.push(makeAdapter("claude-code", true, []))
    readAgentConfigMock.mockResolvedValue({
      path: "/etc/x.json",
      exists: true,
      parsed: {},
    })
    liveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useAgentStatuses())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.projectedCount).toEqual({})
  })
})

describe("getDetectedWritableAgents", () => {
  it("returns only writable agents whose config file exists", async () => {
    adapters.push(
      makeAdapter("writable-present", true, []),
      makeAdapter("writable-missing", true, []),
      makeAdapter("read-only-present", false, [])
    )
    readAgentConfigMock.mockImplementation(async (id: string) => ({
      path: `/etc/${id}.json`,
      exists: id !== "writable-missing",
      parsed: {},
    }))
    const ids = await getDetectedWritableAgents()
    expect(ids).toEqual(["writable-present"])
  })

  it("returns empty list outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    adapters.push(makeAdapter("a", true, []), makeAdapter("b", false, []))
    const ids = await getDetectedWritableAgents()
    expect(ids).toEqual([])
  })
})
