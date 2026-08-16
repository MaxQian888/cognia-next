/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { buildDshChannelManifest } from "@/lib/ai/agent/external/dsh-runtime-install"

const agentInvoke = jest.fn()
const supportsExternalAgents = jest.fn(() => true)

jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => agentInvoke(...args),
  supportsExternalAgents: () => supportsExternalAgents(),
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
  supportsExternalAgents.mockReturnValue(true)
})

describe("useDshRuntime", () => {
  it("checks the runtime on mount", async () => {
    agentInvoke.mockResolvedValue(HEALTHY)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.report?.healthy).toBe(true))
    expect(agentInvoke).toHaveBeenCalledWith("dsh_runtime_facts", {})
  })

  it("reports unsupported hosts without calling the transport", async () => {
    // Web and Capacitor have no runtime home to manage; offering Install there
    // would be a button that cannot work.
    supportsExternalAgents.mockReturnValue(false)
    const { result } = renderHook(() => useDshRuntime("cognia-sdk-readonly"))
    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(agentInvoke).not.toHaveBeenCalled()
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
