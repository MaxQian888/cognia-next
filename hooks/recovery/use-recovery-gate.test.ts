/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { RECOVERY_ORDER, type RecoveryStateV1 } from "@cognia/logging"

import { useRecoveryGate } from "./use-recovery-gate"
import type { RecoveryProbeSet } from "@/lib/recovery/probes"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/recovery", () => ({
  getRecoveryBoot: jest.fn(),
  getRecoveryState: jest.fn(),
  recordRecoveryCheckpoint: jest.fn(),
  retryRecoverySubsystem: jest.fn(),
  sendRecoveryHeartbeat: jest.fn(),
}))
jest.mock("@/lib/recovery/default-probes", () => ({
  createDefaultRecoveryProbes: jest.fn(),
}))

const { isTauri } = jest.requireMock("@/lib/tauri")
const recovery = jest.requireMock("@/lib/tauri/recovery")

function state(overrides: Partial<RecoveryStateV1> = {}): RecoveryStateV1 {
  return {
    schemaVersion: 1,
    buildId: "build-1",
    mode: "normal",
    unhealthyStarts: [],
    checkpoints: RECOVERY_ORDER.map((subsystem) => ({ subsystem, status: "pending" as const })),
    rendererReload: {},
    childRestarts: {},
    disabledSubsystems: [],
    rendererAlive: false,
    audit: [],
    ...overrides,
  }
}

function healthyProbes(): RecoveryProbeSet {
  return Object.fromEntries(
    RECOVERY_ORDER.map((subsystem) => [subsystem, async () => ({ ok: true })])
  ) as RecoveryProbeSet
}

function failingProbes(at: (typeof RECOVERY_ORDER)[number], reasonCode: string): RecoveryProbeSet {
  return Object.fromEntries(
    RECOVERY_ORDER.map((subsystem) => [
      subsystem,
      async () => (subsystem === at ? { ok: false, reasonCode } : { ok: true }),
    ])
  ) as RecoveryProbeSet
}

describe("useRecoveryGate", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    isTauri.mockReturnValue(true)
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: false,
      mode: "normal",
      buildId: "build-1",
      previousSessionUnhealthy: false,
    })
    recovery.getRecoveryState.mockResolvedValue(state())
    recovery.recordRecoveryCheckpoint.mockResolvedValue(state())
    recovery.retryRecoverySubsystem.mockResolvedValue(state())
    recovery.sendRecoveryHeartbeat.mockResolvedValue(state({ rendererAlive: true }))
  })

  it("is normal immediately off-desktop, without an IPC round trip", () => {
    isTauri.mockReturnValue(false)
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    expect(result.current.status).toBe("normal")
    expect(recovery.getRecoveryBoot).not.toHaveBeenCalled()
  })

  it("blocks the tree while the decision is outstanding", () => {
    recovery.getRecoveryBoot.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    expect(result.current.status).toBe("checking")
  })

  it("boots normally when the controller says so", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.status).toBe("normal"))
    expect(result.current.boot?.requiresSafeShell).toBe(false)
  })

  it("enters safe mode when the controller requires the diagnostics shell", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: true,
      mode: "safe",
      buildId: "build-1",
      previousSessionUnhealthy: true,
    })
    recovery.getRecoveryState.mockResolvedValue(state({ mode: "safe" }))
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.status).toBe("safe"))
  })

  it("boots normally when the controller is unreachable rather than refusing to boot", async () => {
    recovery.getRecoveryBoot.mockResolvedValue(null)
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.status).toBe("normal"))
    expect(recovery.recordRecoveryCheckpoint).not.toHaveBeenCalled()
  })

  it("records every checkpoint in order on a healthy boot", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() =>
      expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledTimes(RECOVERY_ORDER.length)
    )
    expect(recovery.recordRecoveryCheckpoint.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      ...RECOVERY_ORDER,
    ])
    await waitFor(() => expect(result.current.probing).toBe(false))
  })

  it("runs probes on a normal boot too, so the healthy timer can ever start", async () => {
    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))
    await waitFor(() => expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalled())
    expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith("database", true, undefined)
  })

  it("stops probing at the first failure and reports its reason code", async () => {
    renderHook(() =>
      useRecoveryGate({
        createProbes: async () => failingProbes("plugins", "plugins.manifest_invalid"),
      })
    )
    await waitFor(() => expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledTimes(2))
    expect(recovery.recordRecoveryCheckpoint).toHaveBeenLastCalledWith(
      "plugins",
      false,
      "plugins.manifest_invalid"
    )
  })

  it("skips subsystems the operator kept disabled", async () => {
    recovery.getRecoveryState.mockResolvedValue(state({ disabledSubsystems: ["plugins"] }))
    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))
    await waitFor(() =>
      expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledTimes(RECOVERY_ORDER.length - 1)
    )
    const probed = recovery.recordRecoveryCheckpoint.mock.calls.map((call: unknown[]) => call[0])
    expect(probed).not.toContain("plugins")
  })

  it("sends a heartbeat as soon as the decision lands", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(recovery.sendRecoveryHeartbeat).toHaveBeenCalled())
    await waitFor(() => expect(result.current.state?.rendererAlive).toBe(true))
  })

  it("keeps heartbeating on the configured interval", async () => {
    jest.useFakeTimers()
    try {
      renderHook(() =>
        useRecoveryGate({ createProbes: async () => healthyProbes(), heartbeatIntervalMs: 1_000 })
      )
      await act(async () => {
        await Promise.resolve()
      })
      const initial = recovery.sendRecoveryHeartbeat.mock.calls.length
      await act(async () => {
        jest.advanceTimersByTime(3_000)
      })
      expect(recovery.sendRecoveryHeartbeat.mock.calls.length).toBeGreaterThan(initial)
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not heartbeat while still checking", () => {
    recovery.getRecoveryBoot.mockReturnValue(new Promise(() => {}))
    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))
    expect(recovery.sendRecoveryHeartbeat).not.toHaveBeenCalled()
  })

  it("re-runs the sequence after a retry so the operator sees the outcome", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.probing).toBe(false))
    recovery.recordRecoveryCheckpoint.mockClear()

    await act(async () => {
      await result.current.retry("plugins")
    })
    expect(recovery.retryRecoverySubsystem).toHaveBeenCalledWith("plugins", "retry")
    await waitFor(() => expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalled())
  })

  it("passes keep-disabled through to the controller", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.probing).toBe(false))
    await act(async () => {
      await result.current.retry("sidecar", "keep-disabled")
    })
    expect(recovery.retryRecoverySubsystem).toHaveBeenCalledWith("sidecar", "keep-disabled")
  })

  it("does not re-probe when the controller refuses a retry", async () => {
    // A refused retry means the controller never reopened the sequence, so
    // re-running the probes would write checkpoints against a board the
    // controller did not change.
    recovery.retryRecoverySubsystem.mockResolvedValue(null)
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.probing).toBe(false))
    recovery.recordRecoveryCheckpoint.mockClear()

    await act(async () => {
      await result.current.retry("plugins")
    })
    expect(recovery.retryRecoverySubsystem).toHaveBeenCalledWith("plugins", "retry")
    expect(recovery.recordRecoveryCheckpoint).not.toHaveBeenCalled()
  })

  it("refreshes state on demand", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.status).toBe("normal"))
    recovery.getRecoveryState.mockResolvedValue(state({ mode: "recovering" }))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.state?.mode).toBe("recovering")
  })
})
