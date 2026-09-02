/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { InstalledRuntime } from "@/lib/ai/agent/external/installed-runtimes"
import type { ProcessPlaneAvailability } from "@/lib/ai/agent/external/process-plane"

const detectInstalledRuntimes = jest.fn()
let plane: ProcessPlaneAvailability = { ok: true, via: "local" }
let scope = "local"

jest.mock("@/lib/ai/agent/external/installed-runtimes", () => ({
  detectInstalledRuntimes: (...args: unknown[]) => detectInstalledRuntimes(...args),
}))
jest.mock("@/lib/ai/agent/external/process-plane", () => ({
  externalAgentProcessPlane: () => plane,
  externalAgentProcessPlaneScope: () => scope,
  PROCESS_PLANE_COMMANDS: { detect: "external_agent_detect_runtimes" },
}))

import { useInstalledAgentRuntimes } from "./use-installed-agent-runtimes"

const CODEX: InstalledRuntime = {
  runtimeId: "codex-app-server",
  command: "codex",
  resolution: "installed",
  executablePath: "/usr/bin/codex",
  version: "0.48.1",
  detail: null,
}

describe("useInstalledAgentRuntimes", () => {
  beforeEach(() => {
    detectInstalledRuntimes.mockReset().mockResolvedValue([CODEX])
    plane = { ok: true, via: "local" }
    scope = "local"
  })

  it("asks nothing until it is enabled", () => {
    renderHook(() => useInstalledAgentRuntimes(false))
    expect(detectInstalledRuntimes).not.toHaveBeenCalled()
  })

  it("maps a detection onto the preset that launches it", async () => {
    const { result } = renderHook(() => useInstalledAgentRuntimes(true))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // The catalog owns the preset-to-runtime link, so the hook never has to
    // keep a preset-to-command mapping of its own that could drift from it.
    expect(result.current.forPreset("codex-app-server")).toEqual(CODEX)
    // A preset the host said nothing about stays unknown. Note that `codex`
    // (the preset) launches the npx-backed `codex-acp` runtime, not this one,
    // which is exactly why the mapping goes through the catalog.
    expect(result.current.forPreset("codex")).toBeUndefined()
    expect(result.current.forPreset("claude-code")).toBeUndefined()
  })

  it("reports the plane's reason instead of asking a host that cannot answer", async () => {
    plane = { ok: false, reason: "not-granted" }
    const { result } = renderHook(() => useInstalledAgentRuntimes(true))
    await waitFor(() => expect(result.current.unavailable).toBe("not-granted"))
    expect(detectInstalledRuntimes).not.toHaveBeenCalled()
    expect(result.current.forPreset("codex")).toBeUndefined()
  })

  it("clears rows when a detection fails rather than leaving a stale answer", async () => {
    detectInstalledRuntimes.mockRejectedValue(new Error("host went away"))
    const { result } = renderHook(() => useInstalledAgentRuntimes(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.runtimes).toEqual([])
    // `failed`, not the plane's `unsupported`: the plane said this Host CAN
    // answer, and it was asked. Borrowing the plane's word for that blamed a
    // Host that had declared the operation for a call that merely did not land.
    expect(result.current.unavailable).toBe("failed")
  })

  it("re-asks with refresh so a just-installed CLI is picked up", async () => {
    const { result } = renderHook(() => useInstalledAgentRuntimes(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(detectInstalledRuntimes).toHaveBeenCalledWith({ refresh: false })

    act(() => result.current.refresh())
    await waitFor(() => expect(detectInstalledRuntimes).toHaveBeenCalledTimes(2))
    expect(detectInstalledRuntimes).toHaveBeenLastCalledWith({ refresh: true })
  })
})
