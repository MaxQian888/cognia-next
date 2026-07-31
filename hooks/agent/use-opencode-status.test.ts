import { renderHook, waitFor } from "@testing-library/react"
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

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getOpenCodeAdapter: () => adapterForAgent,
  }),
}))

beforeEach(() => {
  adapterForAgent = fakeAdapter
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
    expect(result.current.status.project).toBeUndefined()
    expect(result.current.status.mcpServers).toHaveLength(2)
  })
})
