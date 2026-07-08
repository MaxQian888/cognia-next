import { renderHook, act, waitFor } from "@testing-library/react"
import { useCodexAppServerStatus } from "./use-codex-app-server-status"

// getStatus reflects the refreshed snapshot the hook now reads after
// refreshMcpServers/refreshSkills/refreshAccount complete.
const fakeAdapter = {
  getStatus: jest.fn(() => ({
    mcpServers: [{ name: "fs", status: "running" }],
    skills: [{ name: "deploy", path: "/s" }],
    account: { type: "chatgpt", email: "dev@example.com", planType: "pro" },
  })),
  onStatusUpdate: jest.fn((cb: (s: unknown) => void) => {
    statusListener = cb
    return () => {
      statusListener = undefined
    }
  }),
  refreshMcpServers: jest.fn(async () => [{ name: "fs", status: "running" }]),
  refreshSkills: jest.fn(async () => [{ name: "deploy", path: "/s" }]),
  refreshAccount: jest.fn(async () => {}),
}
let statusListener: ((s: unknown) => void) | undefined
let adapterForAgent: typeof fakeAdapter | null = fakeAdapter

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getCodexAppServerAdapter: () => adapterForAgent,
  }),
}))

beforeEach(() => {
  statusListener = undefined
  adapterForAgent = fakeAdapter
  jest.clearAllMocks()
})

describe("useCodexAppServerStatus", () => {
  it("returns the empty snapshot and is unavailable when not connected", () => {
    const { result } = renderHook(() => useCodexAppServerStatus("a1", false))
    expect(result.current.available).toBe(false)
    expect(result.current.status).toEqual({ mcpServers: [], skills: [] })
  })

  it("loads the snapshot, subscribes, and refreshes when connected", async () => {
    const { result } = renderHook(() => useCodexAppServerStatus("a1", true))
    await waitFor(() => expect(result.current.available).toBe(true))
    await waitFor(() =>
      expect(result.current.status.mcpServers[0]).toMatchObject({ name: "fs", status: "running" })
    )
    expect(result.current.status.skills[0]).toMatchObject({ name: "deploy" })
    expect(result.current.status.account).toMatchObject({ email: "dev@example.com" })
    expect(fakeAdapter.refreshAccount).toHaveBeenCalled()
    expect(fakeAdapter.onStatusUpdate).toHaveBeenCalled()
  })

  it("applies live status updates pushed through onStatusUpdate", async () => {
    const { result } = renderHook(() => useCodexAppServerStatus("a1", true))
    await waitFor(() => expect(result.current.available).toBe(true))
    act(() => {
      statusListener?.({ mcpServers: [{ name: "github" }], skills: [] })
    })
    await waitFor(() =>
      expect(result.current.status.mcpServers[0]).toMatchObject({ name: "github" })
    )
  })

  it("stays unavailable when the agent is not an app-server adapter", async () => {
    adapterForAgent = null
    const { result } = renderHook(() => useCodexAppServerStatus("a1", true))
    await waitFor(() => expect(fakeAdapter.refreshMcpServers).not.toHaveBeenCalled())
    expect(result.current.available).toBe(false)
  })

  it("refresh is a no-op when not connected", async () => {
    const { result } = renderHook(() => useCodexAppServerStatus("a1", false))
    await act(async () => {
      await result.current.refresh()
    })
    expect(fakeAdapter.refreshMcpServers).not.toHaveBeenCalled()
  })

  it("refresh is a no-op when no app-server adapter is bound", async () => {
    adapterForAgent = null
    const { result } = renderHook(() => useCodexAppServerStatus("a1", true))
    await act(async () => {
      await result.current.refresh()
    })
    expect(fakeAdapter.refreshSkills).not.toHaveBeenCalled()
  })
})
