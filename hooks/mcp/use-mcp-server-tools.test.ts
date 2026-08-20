/**
 * @jest-environment jsdom
 */

jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn() } },
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

let mockRows: unknown[] | undefined = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockRows }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ mcpCapabilityCache: {} }) }))

const discoverMcpServerViaSidecar = jest.fn()
jest.mock("@/lib/claude/feature-call", () => ({
  discoverMcpServerViaSidecar: (...a: unknown[]) => discoverMcpServerViaSidecar(...a),
}))

const recordMcpCapabilities = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/mcp/runtime-gateway", () => ({
  recordMcpCapabilities: (...a: unknown[]) => recordMcpCapabilities(...a),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useMcpServerTools } from "./use-mcp-server-tools"
import { isTauri } from "@/lib/tauri"
import type { McpServer } from "@cognia/agent-config-types"

const mockIsTauri = isTauri as jest.Mock

const server = {
  id: "mcp_1",
  name: "fs",
  transport: "stdio",
  config: { command: "x" },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as McpServer

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  mockRows = []
  discoverMcpServerViaSidecar.mockReset()
  recordMcpCapabilities.mockClear()
})

describe("useMcpServerTools", () => {
  it("reports an empty, never-discovered server", () => {
    const { result } = renderHook(() => useMcpServerTools(server))
    expect(result.current.tools).toEqual([])
    expect(result.current.discoveredAt).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("flags the query as loading until the live query resolves", () => {
    mockRows = undefined
    const { result } = renderHook(() => useMcpServerTools(server))
    expect(result.current.loading).toBe(true)
  })

  it("takes the freshest cache row and sorts its tools by name", () => {
    mockRows = [
      {
        serverId: "mcp_1",
        updatedAt: 1,
        tools: [{ name: "stale" }],
        resources: [],
        prompts: [],
      },
      {
        serverId: "mcp_1",
        updatedAt: 2,
        tools: [{ name: "write_file" }, { name: "read_file", description: "r" }],
        resources: [{ uri: "file://x" }],
        prompts: [{ name: "p" }],
      },
    ]
    const { result } = renderHook(() => useMcpServerTools(server))
    expect(result.current.tools.map((t) => t.name)).toEqual(["read_file", "write_file"])
    expect(result.current.resourceCount).toBe(1)
    expect(result.current.promptCount).toBe(1)
    expect(result.current.discoveredAt).toBe(2)
  })

  it("keeps an expired row's tool names", () => {
    mockRows = [
      {
        serverId: "mcp_1",
        updatedAt: 5,
        expiresAt: 0,
        tools: [{ name: "still_known" }],
        resources: [],
        prompts: [],
      },
    ]
    // An expiry means "re-discover before connecting", not "forget the names";
    // dropping them would silently un-expand every glob deny rule.
    const { result } = renderHook(() => useMcpServerTools(server))
    expect(result.current.tools.map((t) => t.name)).toEqual(["still_known"])
  })

  it("caches a successful discovery", async () => {
    discoverMcpServerViaSidecar.mockResolvedValue({
      ok: true,
      toolCount: 1,
      tools: [{ name: "a" }],
      resources: [],
      prompts: [],
      durationMs: 1,
    })
    const { result } = renderHook(() => useMcpServerTools(server))
    await act(() => result.current.discover())
    expect(recordMcpCapabilities).toHaveBeenCalledWith(server, {
      tools: [{ name: "a" }],
      resources: [],
      prompts: [],
    })
    expect(result.current.error).toBeNull()
  })

  it("surfaces a failed discovery without caching it", async () => {
    discoverMcpServerViaSidecar.mockResolvedValue({
      ok: false,
      toolCount: 0,
      tools: [],
      resources: [],
      prompts: [],
      error: "spawn ENOENT",
      durationMs: 1,
    })
    const { result } = renderHook(() => useMcpServerTools(server))
    await act(() => result.current.discover())
    await waitFor(() => expect(result.current.error).toBe("spawn ENOENT"))
    expect(recordMcpCapabilities).not.toHaveBeenCalled()
  })

  it("surfaces a thrown discovery", async () => {
    discoverMcpServerViaSidecar.mockRejectedValue(new Error("gateway down"))
    const { result } = renderHook(() => useMcpServerTools(server))
    await act(() => result.current.discover())
    await waitFor(() => expect(result.current.error).toBe("gateway down"))
  })

  it("no-ops off the desktop", async () => {
    mockIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useMcpServerTools(server))
    expect(result.current.canDiscover).toBe(false)
    await act(() => result.current.discover())
    expect(discoverMcpServerViaSidecar).not.toHaveBeenCalled()
  })

  it("no-ops with no server", async () => {
    const { result } = renderHook(() => useMcpServerTools(undefined))
    expect(result.current.canDiscover).toBe(false)
    await act(() => result.current.discover())
    expect(discoverMcpServerViaSidecar).not.toHaveBeenCalled()
  })
})
