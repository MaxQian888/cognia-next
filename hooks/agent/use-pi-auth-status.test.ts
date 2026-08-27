/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { PiAuthVerdict } from "@/lib/ai/agent/external/pi-auth"

import { usePiAuthStatus } from "./use-pi-auth-status"

const VERDICTS: Record<string, PiAuthVerdict> = {
  deepseek: { status: "ready", provider: "deepseek", authType: "api_key" },
  openai: { status: "not_ready", provider: "openai", reason: "credentials_not_configured" },
}

const fakeAdapter = {
  listModelProviders: jest.fn(async () => ({
    status: "ok" as const,
    providers: ["deepseek", "openai"],
  })),
  checkProviderAuth: jest.fn(
    async (provider: string): Promise<PiAuthVerdict> =>
      VERDICTS[provider] ?? { status: "unreadable", provider, unreadableReason: "no_output" }
  ),
}
let adapterForAgent: typeof fakeAdapter | null = fakeAdapter

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getPiRpcAdapter: () => adapterForAgent,
  }),
}))

beforeEach(() => {
  adapterForAgent = fakeAdapter
  jest.clearAllMocks()
})

describe("usePiAuthStatus", () => {
  it("probes nothing until the agent is connected", async () => {
    const { result } = renderHook(() => usePiAuthStatus("pi-1", false))
    expect(result.current.available).toBe(false)
    expect(result.current.status).toEqual({ listing: "idle", verdicts: [] })
    // A probe spawns a process. Not being connected must mean not spawning.
    expect(fakeAdapter.listModelProviders).not.toHaveBeenCalled()
    expect(fakeAdapter.checkProviderAuth).not.toHaveBeenCalled()
  })

  it("is unavailable for an agent that is not on the native Pi adapter", async () => {
    // Any non-Pi ACP agent: no `pi auth check` surface to reach.
    adapterForAgent = null
    const { result } = renderHook(() => usePiAuthStatus("acp-1", true))
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(fakeAdapter.listModelProviders).not.toHaveBeenCalled()
  })

  it("checks each provider Pi reports", async () => {
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))
    expect(result.current.available).toBe(true)
    expect(result.current.status.listing).toBe("ok")
    expect(fakeAdapter.checkProviderAuth.mock.calls.map(([p]) => p)).toEqual(["deepseek", "openai"])
    expect(result.current.status.verdicts).toEqual([VERDICTS.deepseek, VERDICTS.openai])
  })

  it("checks providers one at a time rather than fanning out spawns", async () => {
    // Every check is a sandboxed process spawn; a user with a dozen providers
    // must not launch a dozen `pi` processes at once.
    let inFlight = 0
    let peak = 0
    fakeAdapter.checkProviderAuth.mockImplementation(async (provider: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return VERDICTS[provider] ?? { status: "ready", provider }
    })
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))
    expect(peak).toBe(1)
  })

  it("reports an unreadable listing without inventing verdicts", async () => {
    fakeAdapter.listModelProviders.mockResolvedValueOnce({
      status: "unreadable" as never,
      providers: [] as never,
    })
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    expect(result.current.status.verdicts).toEqual([])
    // Nothing to check, so nothing was checked — and crucially the caller can
    // tell this apart from "Pi has no providers".
    expect(fakeAdapter.checkProviderAuth).not.toHaveBeenCalled()
  })

  it("keeps an empty-but-readable listing distinct from an unreadable one", async () => {
    fakeAdapter.listModelProviders.mockResolvedValueOnce({ status: "ok", providers: [] })
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("ok"))
    expect(result.current.status.verdicts).toEqual([])
  })

  it("re-checks on demand", async () => {
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))
    fakeAdapter.listModelProviders.mockClear()
    await act(async () => {
      await result.current.refresh()
    })
    expect(fakeAdapter.listModelProviders).toHaveBeenCalledTimes(1)
  })

  it("turns a failed spawn into 'could not check', not an unhandled rejection", async () => {
    // `pi` gone from PATH, or no sandbox launcher on this host. The effect
    // calls refresh as `void refresh()`, so an escaping rejection would be an
    // unhandled promise rejection rather than something the user ever sees.
    fakeAdapter.listModelProviders.mockRejectedValueOnce(new Error("spawn failed"))
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    expect(result.current.loading).toBe(false)
  })

  it("recovers a later check after a failed one", async () => {
    fakeAdapter.listModelProviders.mockRejectedValueOnce(new Error("spawn failed"))
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.status.listing).toBe("ok")
    expect(result.current.status.verdicts).toHaveLength(2)
  })
})
