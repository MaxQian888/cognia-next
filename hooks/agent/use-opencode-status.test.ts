import { act, renderHook, waitFor } from "@testing-library/react"
import { useOpencodeStatus } from "./use-opencode-status"

const fakeAdapter = {
  getMcpStatus: jest.fn(async () => ({ fs: { status: "connected" }, gh: { state: "failed" } })),
  getLspStatus: jest.fn(async () => ({ ts: { status: "running" } })),
  getProject: jest.fn(async () => ({ worktree: "/repo", vcs: "git" })),
  getProviders: jest.fn(() => ({
    all: [
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
    ],
    default: {},
    connected: ["anthropic"],
  })),
  getAvailableAgents: jest.fn(() => [{ id: "build", name: "Build" }]),
  getAvailableCommands: jest.fn(() => [{ name: "review", description: "", input: null }]),
}
let adapterForAgent: typeof fakeAdapter | null = fakeAdapter
const v2Client = {
  integration: {
    list: jest.fn(async () => ({
      data: [{ id: "openai", connections: [{ type: "env", name: "OPENAI_API_KEY" }] }],
    })),
  },
  provider: {
    list: jest.fn(async () => ({
      data: [{ id: "openai", name: "OpenAI", activation: "auto", integrationID: "openai" }],
    })),
  },
  agent: { list: jest.fn(async () => ({ data: [{ id: "build", name: "Build" }] })) },
  command: { list: jest.fn(async () => ({ data: [{ name: "review" }] })) },
  mcp: { list: jest.fn(async () => ({ data: [{ name: "fs", status: { status: "connected" } }] })) },
  location: { get: jest.fn(async () => ({ directory: "/v2-project" })) },
}
let v2ForAgent: { getSdkClient: () => typeof v2Client } | null = null
jest.mock("@cognia/agent-opencode/client", () => ({ openCodeServerExtension: "v1" }))
jest.mock("@cognia/agent-opencode/v2-client", () => ({ openCodeV2Extension: "v2" }))

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAdapterExtension: (_id: string, extension: string) =>
      extension === "v1" ? adapterForAgent : v2ForAgent,
    getAgent: () => ({ config: { process: { cwd: "/v2-project" } } }),
  }),
}))

beforeEach(() => {
  adapterForAgent = fakeAdapter
  v2ForAgent = null
  jest.clearAllMocks()
})

describe("useOpencodeStatus", () => {
  it("returns the empty snapshot and is unavailable when not connected", () => {
    const { result } = renderHook(() => useOpencodeStatus("a1", false))
    expect(result.current.available).toBe(false)
    expect(result.current.status.providers).toEqual([])
  })

  it("is unavailable when the agent is not an OpenCode adapter", async () => {
    adapterForAgent = null
    const { result } = renderHook(() => useOpencodeStatus("a1", true))
    // Give the async effect a tick; availability must stay false.
    await waitFor(() => expect(result.current.available).toBe(false))
  })

  it("loads providers/agents/commands/MCP/LSP/project when connected", async () => {
    const { result } = renderHook(() => useOpencodeStatus("a1", true))
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() => expect(result.current.status.providers).toHaveLength(2))
    expect(result.current.status.providers[0]).toMatchObject({
      id: "anthropic",
      connected: true,
    })
    expect(result.current.status.providers[1]).toMatchObject({ id: "openai", connected: false })
    expect(result.current.status.agents[0]).toMatchObject({ id: "build" })
    expect(result.current.status.commands[0]).toMatchObject({ name: "review" })
    // Both `status` and `state` spellings are normalized.
    expect(result.current.status.mcpServers).toEqual([
      { name: "fs", status: "connected" },
      { name: "gh", status: "failed" },
    ])
    expect(result.current.status.lspServers).toEqual([{ id: "ts", status: "running" }])
    expect(result.current.status.project).toEqual({ worktree: "/repo", vcs: "git" })
  })

  it("keeps the other sections when an optional surface rejects", async () => {
    fakeAdapter.getLspStatus.mockRejectedValueOnce(new Error("no lsp"))
    fakeAdapter.getProject.mockRejectedValueOnce(new Error("no project"))
    const { result } = renderHook(() => useOpencodeStatus("a1", true))
    await waitFor(() => expect(result.current.status.providers).toHaveLength(2))
    expect(result.current.status.lspServers).toEqual([])
    expect(result.current.status.surfaces?.lsp).toBe("error")
    expect(result.current.status.project).toBeUndefined()
    expect(result.current.status.mcpServers).toHaveLength(2)
  })
})

it("keeps a failed MCP read distinct from empty and recovers on retry", async () => {
  fakeAdapter.getMcpStatus.mockRejectedValueOnce(new Error("MCP unavailable"))
  const { result } = renderHook(() => useOpencodeStatus("a1", true))
  await waitFor(() => expect(result.current.status.surfaces?.mcp).toBe("error"))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.status.surfaces?.mcp).toBe("ready")
  expect(result.current.status.mcpServers).toHaveLength(2)
})

it("reads V2 native surfaces and provider connections, and marks unsupported LSP", async () => {
  adapterForAgent = null
  v2ForAgent = { getSdkClient: () => v2Client }
  const { result } = renderHook(() => useOpencodeStatus("v2", true))
  await waitFor(() => expect(result.current.status.providers).toHaveLength(1))
  expect(result.current.available).toBe(true)
  expect(v2Client.mcp.list).toHaveBeenCalledWith({ location: { directory: "/v2-project" } })
  expect(result.current.status.mcpServers).toEqual([{ name: "fs", status: "connected" }])
  expect(result.current.status.agents).toEqual([{ id: "build", name: "Build" }])
  expect(result.current.status.commands).toEqual([{ name: "review" }])
  expect(result.current.status.project).toEqual({ worktree: "/v2-project" })
  expect(result.current.status.surfaces?.lsp).toBe("unsupported")
  expect(result.current.status.providers[0].connected).toBe(true)
})

it("shows errors independently for V2 surfaces", async () => {
  adapterForAgent = null
  v2ForAgent = { getSdkClient: () => v2Client }
  v2Client.mcp.list.mockRejectedValueOnce(new Error("MCP unavailable"))
  const { result } = renderHook(() => useOpencodeStatus("v2", true))
  await waitFor(() => expect(result.current.status.surfaces?.mcp).toBe("error"))
  expect(result.current.status.commands).toHaveLength(1)
})

it("ignores a status response after switching agents", async () => {
  let finish!: (value: { fs: { status: string }; gh: { state: string } }) => void
  fakeAdapter.getMcpStatus.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result, rerender } = renderHook(({ id, connected }) => useOpencodeStatus(id, connected), {
    initialProps: { id: "first", connected: true },
  })
  await waitFor(() => expect(fakeAdapter.getMcpStatus).toHaveBeenCalled())
  rerender({ id: "second", connected: false })
  await act(async () => {
    finish({ fs: { status: "old" }, gh: { state: "old" } })
  })
  expect(result.current.available).toBe(false)
  expect(result.current.status.mcpServers).toEqual([])
})

it("keeps failed V2 integration reads unknown with retry state", async () => {
  adapterForAgent = null
  v2ForAgent = { getSdkClient: () => v2Client }
  v2Client.integration.list.mockRejectedValueOnce(new Error("integration unavailable"))
  const { result } = renderHook(() => useOpencodeStatus("v2", true))
  await waitFor(() => expect(result.current.status.surfaces?.providerAuth).toBe("error"))
  expect(result.current.status.providers[0].connected).toBeUndefined()
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.status.providers[0].connected).toBe(true)
})

it("clears the old snapshot while a different connected agent is loading", async () => {
  const { result, rerender } = renderHook(({ id }) => useOpencodeStatus(id, true), {
    initialProps: { id: "first" },
  })
  await waitFor(() => expect(result.current.status.providers).toHaveLength(2))
  let finish!: (value: { fs: { status: string }; gh: { state: string } }) => void
  fakeAdapter.getMcpStatus.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  rerender({ id: "second" })
  expect(result.current.status.providers).toEqual([])
  expect(result.current.loading).toBe(true)
  await waitFor(() => expect(fakeAdapter.getMcpStatus).toHaveBeenCalledTimes(2))
  await act(async () => {
    finish({ fs: { status: "connected" }, gh: { state: "connected" } })
  })
  expect(result.current.status.providers).toHaveLength(2)
})
