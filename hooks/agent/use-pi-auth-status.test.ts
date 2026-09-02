/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { PiAuthVerdict } from "@/lib/ai/agent/external/pi-auth"

import { __resetPiAuthStatusForTests, usePiAuthStatus } from "./use-pi-auth-status"

const VERDICTS: Record<string, PiAuthVerdict> = {
  deepseek: { status: "ready", provider: "deepseek", authType: "api_key" },
  openai: { status: "not_ready", provider: "openai", reason: "credentials_not_configured" },
}

const LISTED = [
  { provider: "deepseek", id: "deepseek-v4-pro" },
  { provider: "openai", id: "gpt-5" },
]

const fakeAdapter = {
  listAgentModels: jest.fn(async () => ({
    status: "ok" as const,
    models: LISTED,
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
  // The probe is shared per agent across every mount, which is the point of
  // it. Each case here is about a fresh agent, so it starts from nothing.
  __resetPiAuthStatusForTests()
})

describe("usePiAuthStatus", () => {
  it("probes nothing until the agent is connected", async () => {
    const { result } = renderHook(() => usePiAuthStatus("pi-1", false))
    expect(result.current.available).toBe(false)
    expect(result.current.status).toEqual({ listing: "idle", verdicts: [], models: [] })
    // A probe spawns a process. Not being connected must mean not spawning.
    expect(fakeAdapter.listAgentModels).not.toHaveBeenCalled()
    expect(fakeAdapter.checkProviderAuth).not.toHaveBeenCalled()
  })

  it("is unavailable for an agent that is not on the native Pi adapter", async () => {
    // Any non-Pi ACP agent: no `pi auth check` surface to reach.
    adapterForAgent = null
    const { result } = renderHook(() => usePiAuthStatus("acp-1", true))
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(fakeAdapter.listAgentModels).not.toHaveBeenCalled()
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
    fakeAdapter.listAgentModels.mockResolvedValueOnce({
      status: "unreadable" as never,
      models: [] as never,
    })
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    expect(result.current.status.verdicts).toEqual([])
    // Nothing to check, so nothing was checked — and crucially the caller can
    // tell this apart from "Pi has no providers".
    expect(fakeAdapter.checkProviderAuth).not.toHaveBeenCalled()
  })

  it("keeps an empty-but-readable listing distinct from an unreadable one", async () => {
    fakeAdapter.listAgentModels.mockResolvedValueOnce({ status: "ok", models: [] })
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("ok"))
    expect(result.current.status.verdicts).toEqual([])
  })

  it("re-checks on demand", async () => {
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))
    fakeAdapter.listAgentModels.mockClear()
    await act(async () => {
      await result.current.refresh()
    })
    expect(fakeAdapter.listAgentModels).toHaveBeenCalledTimes(1)
  })

  it("turns a failed spawn into 'could not check', not an unhandled rejection", async () => {
    // `pi` gone from PATH, or no sandbox launcher on this host. The effect
    // calls refresh as `void refresh()`, so an escaping rejection would be an
    // unhandled promise rejection rather than something the user ever sees.
    fakeAdapter.listAgentModels.mockRejectedValueOnce(new Error("spawn failed"))
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    expect(result.current.loading).toBe(false)
  })

  it("spawns once for an agent however many places are showing it", async () => {
    // The badge now sits on every runtime-picker row and every manager card.
    // A probe per mount meant N rows times M providers of process spawns on
    // every open, for a fact that had not moved since the last one.
    const first = renderHook(() => usePiAuthStatus("pi-1", true))
    const second = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(first.result.current.status.verdicts).toHaveLength(2))
    await waitFor(() => expect(second.result.current.status.verdicts).toHaveLength(2))
    expect(fakeAdapter.listAgentModels).toHaveBeenCalledTimes(1)
    expect(fakeAdapter.checkProviderAuth).toHaveBeenCalledTimes(2)

    // And reopening the surface costs nothing.
    first.unmount()
    second.unmount()
    const reopened = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(reopened.result.current.status.verdicts).toHaveLength(2))
    expect(fakeAdapter.listAgentModels).toHaveBeenCalledTimes(1)
  })

  it("forgets the answer when the agent disconnects", async () => {
    // The next connect may be a different process with different credentials,
    // so a cached verdict there would be a claim about a dead one.
    const { result, rerender } = renderHook(
      ({ connected }: { connected: boolean }) => usePiAuthStatus("pi-1", connected),
      { initialProps: { connected: true } }
    )
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))

    rerender({ connected: false })
    await waitFor(() =>
      expect(result.current.status).toEqual({ listing: "idle", verdicts: [], models: [] })
    )

    rerender({ connected: true })
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(2))
    expect(fakeAdapter.listAgentModels).toHaveBeenCalledTimes(2)
  })

  it("ignores a probe that finishes after disconnect", async () => {
    let finish: (value: unknown) => void = () => {}
    fakeAdapter.listAgentModels.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve as (value: unknown) => void
      })
    )
    const { result, rerender } = renderHook(
      ({ connected }: { connected: boolean }) => usePiAuthStatus("pi-1", connected),
      { initialProps: { connected: true } }
    )
    await waitFor(() => expect(result.current.loading).toBe(true))
    rerender({ connected: false })
    finish({ status: "ok", providers: ["deepseek"] })
    await act(async () => {})
    expect(result.current.status).toEqual({ listing: "idle", verdicts: [], models: [] })
    expect(result.current.available).toBe(false)
  })

  it("recovers a later check after a failed one", async () => {
    fakeAdapter.listAgentModels.mockRejectedValueOnce(new Error("spawn failed"))
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.listing).toBe("unreadable"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.status.listing).toBe("ok")
    expect(result.current.status.verdicts).toHaveLength(2)
  })

  it("keeps the model catalog and reconciles an extension provider against it", async () => {
    // `pi auth check` does not load extension-registered providers, so it
    // answers `provider_not_found` for one whose models `--list-models` still
    // offers. Listed means credentials resolved, and the verdict must say so.
    fakeAdapter.listAgentModels.mockResolvedValueOnce({
      status: "ok",
      models: [{ provider: "commandcode", id: "claude-opus-5" }, ...LISTED],
    })
    fakeAdapter.checkProviderAuth.mockImplementationOnce(async (provider: string) => ({
      status: "not_ready",
      provider,
      reason: "provider_not_found",
    }))
    const { result } = renderHook(() => usePiAuthStatus("pi-1", true))
    await waitFor(() => expect(result.current.status.verdicts).toHaveLength(3))
    expect(result.current.status.verdicts[0]).toEqual({
      status: "ready",
      provider: "commandcode",
      evidence: "model_listing",
    })
    expect(result.current.status.models).toHaveLength(3)
  })
})
