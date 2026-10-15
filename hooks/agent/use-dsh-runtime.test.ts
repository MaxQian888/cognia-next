/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { buildDshChannelManifest } from "@cognia/agent-dsh/install"

const agentInvoke = jest.fn()
const runsLocally = jest.fn(() => true)

jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => agentInvoke(...args),
  runsExternalAgentProcessesLocally: () => runsLocally(),
}))

const activeSessionsForRuntime = jest.fn((_runtimeId: string) => 0)
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({
    activeSessionsForRuntime: (runtimeId: string) => activeSessionsForRuntime(runtimeId),
  }),
}))

import { useDshRuntime } from "./use-dsh-runtime"

const DIGESTS = { lockfileDigest: "1".repeat(64), compositionDigest: "2".repeat(64) }
const MANIFEST = buildDshChannelManifest(DIGESTS)

/** Facts a host returns from disk; the verdict is rendered in the hook. */
function facts(overrides: Record<string, unknown> = {}) {
  return {
    manifestJson: JSON.stringify(MANIFEST),
    lockfileDigest: DIGESTS.lockfileDigest,
    compositionDigest: DIGESTS.compositionDigest,
    nodeVersion: "v26.0.0",
    platform: "darwin-arm64",
    strayPatchPaths: [],
    hasNativeToolchain: true,
    ...overrides,
  }
}

const HEALTHY = facts()
/** Nothing installed: no manifest to judge. */
const NOT_INSTALLED = facts({ manifestJson: null })
const UNHEALTHY = facts({ compositionDigest: "9".repeat(64) })

beforeEach(() => {
  agentInvoke.mockReset()
  runsLocally.mockReturnValue(true)
  activeSessionsForRuntime.mockReturnValue(0)
})

describe("useDshRuntime", () => {
  it("checks the runtime on mount", async () => {
    agentInvoke.mockResolvedValue(HEALTHY)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.report?.healthy).toBe(true))
    expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_facts", {})
  })

  it("keeps installation unknown and marks the first doctor request busy", async () => {
    let resolveFacts!: (value: ReturnType<typeof facts>) => void
    agentInvoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFacts = resolve
      })
    )
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    expect(result.current.busy).toBe(true)
    expect(result.current.report).toBeUndefined()
    expect(result.current.installed).toBeUndefined()

    await act(async () => {
      resolveFacts(HEALTHY)
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.installed).toBe(true)
  })

  it("keeps a failed first check unknown and retries the doctor", async () => {
    agentInvoke.mockRejectedValueOnce(new Error("doctor failed"))
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.error).toBe("doctor failed"))
    expect(result.current.busy).toBe(false)
    expect(result.current.report).toBeUndefined()
    expect(result.current.installed).toBeUndefined()

    agentInvoke.mockResolvedValueOnce(NOT_INSTALLED)
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBeUndefined()
    expect(result.current.installed).toBe(false)
    expect(result.current.busy).toBe(false)
  })

  it("does not show a previous profile's verdict while checking a new profile", async () => {
    agentInvoke.mockResolvedValueOnce(HEALTHY)
    const { result, rerender } = renderHook(
      ({ profile }: { profile: "cognia-sdk-readonly" | "cognia-sdk-workspace" }) =>
        useDshRuntime(profile),
      { initialProps: { profile: "cognia-sdk-readonly" } }
    )
    await waitFor(() => expect(result.current.installed).toBe(true))
    let resolveFacts!: (value: ReturnType<typeof facts>) => void
    agentInvoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFacts = resolve
      })
    )
    rerender({ profile: "cognia-sdk-workspace" })
    expect(result.current.busy).toBe(true)
    expect(result.current.report).toBeUndefined()
    expect(result.current.installed).toBeUndefined()
    await act(async () => {
      resolveFacts(HEALTHY)
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.installed).toBe(true)
  })

  it("ignores an old profile's doctor response after the profile changes", async () => {
    let resolvePrevious!: (value: ReturnType<typeof facts>) => void
    agentInvoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrevious = resolve
      })
    )
    const { result, rerender } = renderHook(
      ({ profile }: { profile: "cognia-sdk-readonly" | "cognia-sdk-workspace" }) =>
        useDshRuntime(profile),
      { initialProps: { profile: "cognia-sdk-readonly" } }
    )
    agentInvoke.mockResolvedValueOnce(HEALTHY)
    rerender({ profile: "cognia-sdk-workspace" })
    await waitFor(() => expect(result.current.installed).toBe(true))
    await act(async () => {
      resolvePrevious(NOT_INSTALLED)
    })
    expect(result.current.installed).toBe(true)
  })

  it.each(["resolve", "reject"])(
    "ignores a previous profile's manual refresh %s",
    async (outcome) => {
      agentInvoke.mockResolvedValueOnce(HEALTHY)
      const { result, rerender } = renderHook(
        ({ profile }: { profile: "cognia-sdk-readonly" | "cognia-sdk-workspace" }) =>
          useDshRuntime(profile),
        { initialProps: { profile: "cognia-sdk-readonly" } }
      )
      await waitFor(() => expect(result.current.installed).toBe(true))
      let resolvePrevious!: (value: ReturnType<typeof facts>) => void
      let rejectPrevious!: (reason: Error) => void
      agentInvoke.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolvePrevious = resolve
          rejectPrevious = reject
        })
      )
      let pendingRefresh!: Promise<void>
      act(() => {
        pendingRefresh = result.current.refresh()
      })
      agentInvoke.mockResolvedValueOnce(HEALTHY)
      rerender({ profile: "cognia-sdk-workspace" })
      await waitFor(() => expect(result.current.report?.healthy).toBe(true))
      await act(async () => {
        if (outcome === "resolve") resolvePrevious(NOT_INSTALLED)
        else rejectPrevious(new Error("old profile failed"))
        await pendingRefresh
      })
      expect(result.current.installed).toBe(true)
      expect(result.current.report?.healthy).toBe(true)
      expect(result.current.error).toBeUndefined()
      expect(result.current.busy).toBe(false)
    }
  )

  it("reports unsupported hosts without calling the transport", async () => {
    // Web and Capacitor have no runtime home to manage; offering Install there
    // would be a button that cannot work.
    runsLocally.mockReturnValue(false)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(agentInvoke).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it("treats a channel-malformed finding as not installed", async () => {
    // That is the code doctor returns when there is no manifest at all, which is
    // what decides whether the UI offers Install or Reinstall.
    agentInvoke.mockResolvedValue(NOT_INSTALLED)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.report).toBeDefined())
    expect(result.current.installed).toBe(false)
  })

  it("treats an unhealthy-but-present runtime as installed", async () => {
    agentInvoke.mockResolvedValue(UNHEALTHY)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.installed).toBe(true))
    expect(result.current.report?.healthy).toBe(false)
  })

  it("re-checks after installing rather than assuming health", async () => {
    // An install can succeed while the platform or Node version still fails
    // preflight, so success alone is not evidence of a usable runtime.
    agentInvoke.mockResolvedValueOnce(NOT_INSTALLED)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.installed).toBe(false))

    agentInvoke
      .mockResolvedValueOnce(DIGESTS)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(UNHEALTHY)
    await act(async () => {
      await result.current.install()
    })
    expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_install", {})
    // The manifest is built here, not by the host, so both hosts certify the
    // same channel.
    expect(agentInvoke).toHaveBeenCalledWith(
      "dsh_runtime_finalize",
      expect.objectContaining({ manifestJson: expect.stringContaining("schemaVersion") })
    )
    expect(result.current.report?.healthy).toBe(false)
  })

  it("re-checks after removing", async () => {
    agentInvoke.mockResolvedValueOnce(HEALTHY)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.installed).toBe(true))

    agentInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(NOT_INSTALLED)
    await act(async () => {
      await result.current.remove()
    })
    expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_remove", { activeSessionCount: 0 })
    expect(result.current.installed).toBe(false)
  })

  it("sends the real live-session count, not a literal zero", async () => {
    // The host refuses removal while sessions are live, but this caller used to
    // hard-code 0 -- so the guard could never fire and a running agent's tree
    // could be swapped out from under it.
    activeSessionsForRuntime.mockReturnValue(2)
    agentInvoke.mockResolvedValueOnce(HEALTHY)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.installed).toBe(true))

    agentInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(NOT_INSTALLED)
    await act(async () => {
      await result.current.remove()
    })

    expect(activeSessionsForRuntime).toHaveBeenCalledWith("deepseek-harness")
    expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_remove", { activeSessionCount: 2 })
  })

  it("surfaces a lifecycle failure instead of leaving the UI silent", async () => {
    agentInvoke.mockResolvedValueOnce(NOT_INSTALLED)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.report).toBeDefined())

    agentInvoke.mockRejectedValueOnce(new Error("npm install failed"))
    await act(async () => {
      await result.current.install()
    })
    expect(result.current.error).toBe("npm install failed")
    expect(result.current.busy).toBe(false)
  })

  it("clears a previous error when a later call succeeds", async () => {
    agentInvoke.mockResolvedValueOnce(NOT_INSTALLED)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.report).toBeDefined())

    agentInvoke.mockRejectedValueOnce(new Error("boom"))
    await act(async () => {
      await result.current.install()
    })
    expect(result.current.error).toBe("boom")

    agentInvoke.mockResolvedValueOnce(HEALTHY)
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBeUndefined()
  })

  it("gathers facts once per profile", async () => {
    agentInvoke.mockResolvedValue(HEALTHY)
    renderHook(() => useDshRuntime("cognia-sdk-workspace"))
    await waitFor(() => expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_facts", {}))
  })

  it("stringifies a non-Error rejection", async () => {
    agentInvoke.mockRejectedValueOnce("plain string failure")
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.error).toBe("plain string failure"))
  })
})
