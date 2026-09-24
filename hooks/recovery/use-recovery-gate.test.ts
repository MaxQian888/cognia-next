/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { RECOVERY_ORDER, type RecoveryStateV1 } from "@cognia/logging"

import { useRecoveryGate } from "./use-recovery-gate"
import type { RecoveryProbeSet } from "@/lib/recovery/probes"
import {
  __resetSecretStoreReadinessForTesting,
  deferUntilSecretStoreReady,
  getSecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/recovery", () => ({
  getRecoveryBoot: jest.fn(),
  getRecoveryState: jest.fn(),
  recordRecoveryCheckpoint: jest.fn(),
  retryRecoverySubsystem: jest.fn(),
  sendRecoveryHeartbeat: jest.fn(),
  unlockSecretStore: jest.fn(),
}))
jest.mock("@/lib/recovery/default-probes", () => ({
  createDefaultRecoveryProbes: jest.fn(),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ensureSidecarReady: jest.fn(),
}))
jest.mock("@/stores/network-proxy", () => ({
  applyProxyToRust: jest.fn(),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: jest.fn(),
    subscribe: jest.fn(),
  },
}))

const { isTauri } = jest.requireMock("@/lib/tauri")
const recovery = jest.requireMock("@/lib/tauri/recovery")
const { ensureSidecarReady } = jest.requireMock("@/lib/claude/ipc")
const { applyProxyToRust } = jest.requireMock("@/stores/network-proxy")
const { useSettingsStore } = jest.requireMock("@/stores/settings/settings-store")

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
    __resetSecretStoreReadinessForTesting()
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
    recovery.sendRecoveryHeartbeat.mockImplementation(async () => ({
      ...(await recovery.getRecoveryState()),
      rendererAlive: true,
    }))
    useSettingsStore.getState.mockReset().mockReturnValue({
      loaded: true,
      ensureProviderKeys: jest.fn(async () => undefined),
    })
    useSettingsStore.subscribe.mockReset().mockReturnValue(jest.fn())
    applyProxyToRust.mockResolvedValue(undefined)
    ensureSidecarReady.mockResolvedValue({ ready: true })
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

  it("keeps the application tree blocked until the Agent Host is ready", async () => {
    let resolveSidecar: ((value: { ready: true }) => void) | undefined
    ensureSidecarReady.mockReturnValue(
      new Promise<{ ready: true }>((resolve) => {
        resolveSidecar = resolve
      })
    )

    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )

    await waitFor(() => expect(ensureSidecarReady).toHaveBeenCalledTimes(1))
    expect(result.current.status).toBe("checking")

    act(() => resolveSidecar?.({ ready: true }))
    await waitFor(() => expect(result.current.status).toBe("normal"))
  })

  it("enters safe mode when the controller requires the diagnostics shell", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: true,
      mode: "safe",
      buildId: "build-1",
      previousSessionUnhealthy: true,
    })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "sidecar" })
    )
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
    await waitFor(() => expect(ensureSidecarReady).toHaveBeenCalledTimes(1))
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

  it("starts the Agent Host before probing the sidecar on a normal desktop boot", async () => {
    const probes = healthyProbes()
    const sidecarProbe = jest.fn(async () => ({ ok: true }))
    probes.sidecar = sidecarProbe

    renderHook(() => useRecoveryGate({ createProbes: async () => probes }))

    await waitFor(() => expect(sidecarProbe).toHaveBeenCalled())
    expect(applyProxyToRust).toHaveBeenCalledTimes(1)
    expect(ensureSidecarReady).toHaveBeenCalledTimes(1)
    expect(applyProxyToRust.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSidecarReady.mock.invocationCallOrder[0]
    )
    expect(ensureSidecarReady.mock.invocationCallOrder[0]).toBeLessThan(
      sidecarProbe.mock.invocationCallOrder[0]
    )
  })

  it("waits for account settings before applying the proxy policy and starting the sidecar", async () => {
    let onSettingsChange: ((next: { loaded: boolean }) => void) | undefined
    useSettingsStore.getState.mockReturnValue({ loaded: false })
    useSettingsStore.subscribe.mockImplementation(
      (listener: (next: { loaded: boolean }) => void) => {
        onSettingsChange = listener
        return jest.fn()
      }
    )

    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))

    await waitFor(() => expect(useSettingsStore.subscribe).toHaveBeenCalledTimes(1))
    expect(applyProxyToRust).not.toHaveBeenCalled()
    expect(ensureSidecarReady).not.toHaveBeenCalled()

    useSettingsStore.getState.mockReturnValue({ loaded: true })
    act(() => onSettingsChange?.({ loaded: true }))

    await waitFor(() => expect(ensureSidecarReady).toHaveBeenCalledTimes(1))
    expect(applyProxyToRust.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSidecarReady.mock.invocationCallOrder[0]
    )
  })

  it("closes the hydration snapshot-subscribe race before starting the sidecar", async () => {
    const unsubscribe = jest.fn()
    useSettingsStore.getState
      .mockReturnValueOnce({ loaded: false })
      .mockReturnValue({ loaded: true })
    useSettingsStore.subscribe.mockReturnValue(unsubscribe)

    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))

    await waitFor(() => expect(ensureSidecarReady).toHaveBeenCalledTimes(1))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(applyProxyToRust.mock.invocationCallOrder[0]).toBeLessThan(
      ensureSidecarReady.mock.invocationCallOrder[0]
    )
  })

  it("does not auto-start a suspected sidecar while entering safe mode", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: true,
      mode: "safe",
      buildId: "build-1",
      previousSessionUnhealthy: true,
    })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "sidecar" })
    )

    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )

    await waitFor(() => expect(result.current.status).toBe("safe"))
    expect(result.current.probing).toBe(false)
    expect(ensureSidecarReady).not.toHaveBeenCalled()
  })

  it("respects an operator-disabled sidecar on a normal boot", async () => {
    recovery.getRecoveryState.mockResolvedValue(state({ disabledSubsystems: ["sidecar"] }))

    renderHook(() => useRecoveryGate({ createProbes: async () => healthyProbes() }))

    await waitFor(() => expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalled())
    expect(ensureSidecarReady).not.toHaveBeenCalled()
  })

  it("records probe evidence when startup fails instead of hanging the recovery gate", async () => {
    ensureSidecarReady.mockRejectedValue(new Error("bundled Node failed"))

    renderHook(() =>
      useRecoveryGate({
        createProbes: async () => failingProbes("sidecar", "sidecar.start_failed"),
      })
    )

    await waitFor(() =>
      expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith(
        "sidecar",
        false,
        "sidecar.start_failed"
      )
    )
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

  it("starts the sidecar before re-probing an explicit sidecar retry", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: true,
      mode: "safe",
      buildId: "build-1",
      previousSessionUnhealthy: true,
    })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "sidecar" })
    )
    const probes = healthyProbes()
    const sidecarProbe = jest.fn(async () => ({ ok: true }))
    probes.sidecar = sidecarProbe
    const { result } = renderHook(() => useRecoveryGate({ createProbes: async () => probes }))
    await waitFor(() => expect(result.current.probing).toBe(false))
    ensureSidecarReady.mockClear()
    sidecarProbe.mockClear()

    await act(async () => {
      await result.current.retry("sidecar")
    })

    await waitFor(() => expect(sidecarProbe).toHaveBeenCalled())
    expect(ensureSidecarReady).toHaveBeenCalledTimes(1)
    expect(ensureSidecarReady.mock.invocationCallOrder[0]).toBeLessThan(
      sidecarProbe.mock.invocationCallOrder[0]
    )
  })

  it("passes keep-disabled through to the controller", async () => {
    recovery.retryRecoverySubsystem.mockResolvedValue(state({ disabledSubsystems: ["sidecar"] }))
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.probing).toBe(false))
    ensureSidecarReady.mockClear()
    await act(async () => {
      await result.current.retry("sidecar", "keep-disabled")
    })
    expect(recovery.retryRecoverySubsystem).toHaveBeenCalledWith("sidecar", "keep-disabled")
    expect(ensureSidecarReady).not.toHaveBeenCalled()
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

  it("keeps retry usable after native retry fails", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({ requiresSafeShell: true, mode: "safe" })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "sidecar" })
    )
    recovery.retryRecoverySubsystem.mockRejectedValueOnce(new Error("keychain timeout"))
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.state?.suspectSubsystem).toBe("sidecar"))
    await act(async () => {
      await result.current.retry("sidecar")
    })
    expect(result.current.probing).toBe(false)
    expect(result.current.status).toBe("safe")
    expect(result.current.state?.suspectSubsystem).toBe("sidecar")
    expect(ensureSidecarReady).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.retry("sidecar")
    })
    expect(result.current.status).toBe("normal")
  })
  it("starts a cold sidecar after upstream checks when recovering from a renderer failure", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({ requiresSafeShell: true, mode: "safe" })
    recovery.getRecoveryState.mockResolvedValue(state({ mode: "safe" }))
    const order: string[] = []
    let ready = false
    ensureSidecarReady.mockImplementation(async () => {
      order.push("start")
      ready = true
      return { ready: true }
    })
    const probes = healthyProbes()
    probes.database = async () => {
      order.push("database")
      return { ok: true }
    }
    probes.plugins = async () => {
      order.push("plugins")
      return { ok: true }
    }
    probes.sidecar = async () => {
      order.push("sidecar")
      return { ok: ready, reasonCode: ready ? undefined : "sidecar.not_ready" }
    }

    const { result } = renderHook(() => useRecoveryGate({ createProbes: async () => probes }))
    await waitFor(() => expect(result.current.status).toBe("normal"))
    expect(order).toEqual(["database", "plugins", "start", "sidecar"])
    expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith("sidecar", true, undefined)
  })

  it("does not start the sidecar when an earlier prerequisite fails", async () => {
    const { result } = renderHook(() =>
      useRecoveryGate({
        createProbes: async () => failingProbes("database", "database.unreadable"),
      })
    )
    await waitFor(() => expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalled())
    expect(ensureSidecarReady).not.toHaveBeenCalled()
    expect(result.current.status).toBe("safe")
  })

  it("preserves a suspected sidecar failure until an explicit retry then leaves the safe shell", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({ requiresSafeShell: true, mode: "safe" })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "sidecar" })
    )
    const probes = healthyProbes()
    const sidecarProbe = jest.fn(async () => ({ ok: true }))
    probes.sidecar = sidecarProbe
    const { result } = renderHook(() => useRecoveryGate({ createProbes: async () => probes }))
    await waitFor(() => expect(result.current.state?.suspectSubsystem).toBe("sidecar"))
    expect(sidecarProbe).not.toHaveBeenCalled()
    expect(ensureSidecarReady).not.toHaveBeenCalled()

    let finishStart!: (value: { ready: boolean }) => void
    ensureSidecarReady.mockReturnValue(
      new Promise((resolve) => {
        finishStart = resolve
      })
    )
    let retry!: Promise<void>
    act(() => {
      retry = result.current.retry("sidecar")
    })
    await waitFor(() => expect(ensureSidecarReady).toHaveBeenCalledTimes(1))
    expect(result.current.probing).toBe(true)
    expect(result.current.status).toBe("safe")
    await act(async () => {
      await result.current.retry("sidecar")
      finishStart({ ready: true })
      await retry
    })
    expect(recovery.retryRecoverySubsystem).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe("normal")
  })

  it("does not mark a rejected startup healthy even if a stale readiness probe passes", async () => {
    ensureSidecarReady.mockRejectedValue(new Error("startup failed"))
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.probing).toBe(false))
    await waitFor(() =>
      expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith(
        "sidecar",
        false,
        "sidecar.start_failed"
      )
    )
    expect(result.current.status).toBe("safe")
  })
  it("starts a cold sidecar after retrying an upstream failure", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({ requiresSafeShell: true, mode: "safe" })
    recovery.getRecoveryState.mockResolvedValue(
      state({ mode: "safe", suspectSubsystem: "plugins" })
    )
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.state?.suspectSubsystem).toBe("plugins"))
    expect(ensureSidecarReady).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.retry("plugins")
    })
    expect(ensureSidecarReady).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe("normal")
  })

  it("keeps the safe shell until downstream checks finish even when the controller is recovering", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({ requiresSafeShell: true, mode: "safe" })
    recovery.getRecoveryState.mockResolvedValue(state({ mode: "safe" }))
    recovery.recordRecoveryCheckpoint.mockResolvedValue(state({ mode: "recovering" }))
    const probes = healthyProbes()
    let finish!: (value: { ok: boolean }) => void
    probes["external-agent"] = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useRecoveryGate({ createProbes: async () => probes }))
    await waitFor(() => expect(probes["external-agent"]).toHaveBeenCalled())
    expect(result.current.status).toBe("safe")
    expect(result.current.probing).toBe(true)
    await act(async () => {
      finish({ ok: true })
    })
    await waitFor(() => expect(result.current.status).toBe("normal"))
  })

  it("rejects a startup response that did not confirm readiness", async () => {
    ensureSidecarReady.mockResolvedValue({ ready: false })
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() =>
      expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith(
        "sidecar",
        false,
        "sidecar.not_ready"
      )
    )
    expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledTimes(3)
    expect(result.current.status).toBe("safe")
  })
  it.each([
    [new Error("proxy://user:secret@example.com"), "proxy.apply_failed"],
    [{ code: "PROXY_CREDENTIAL_UNAVAILABLE", message: "secret" }, "proxy.credential_unavailable"],
    [new Error("PROXY_CREDENTIAL_UNAVAILABLE"), "proxy.credential_unavailable"],
  ])("reports proxy failure separately and allows explicit retry", async (error, reasonCode) => {
    applyProxyToRust.mockRejectedValueOnce(error)
    const probes = healthyProbes()
    const sidecarProbe = jest.fn(async () => ({ ok: true }))
    probes.sidecar = sidecarProbe
    const { result } = renderHook(() => useRecoveryGate({ createProbes: async () => probes }))
    await waitFor(() => expect(result.current.status).toBe("safe"))
    expect(recovery.recordRecoveryCheckpoint).toHaveBeenCalledWith("sidecar", false, reasonCode)
    expect(ensureSidecarReady).not.toHaveBeenCalled()
    expect(sidecarProbe).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.retry("sidecar")
    })
    expect(result.current.status).toBe("normal")
    expect(ensureSidecarReady).toHaveBeenCalledTimes(1)
    expect(sidecarProbe).toHaveBeenCalledTimes(1)
  })

  it("publishes a locked store from the boot answer without entering safe mode", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: false,
      mode: "normal",
      buildId: "build-1",
      previousSessionUnhealthy: false,
      secretStore: "locked",
    })
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.status).toBe("normal"))
    expect(result.current.secretStore).toBe("locked")
    expect(getSecretStoreReadiness()).toBe("locked")
  })

  it("unlocks explicitly, then re-runs deferred consumers, the proxy and speech keys", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: false,
      mode: "normal",
      buildId: "build-1",
      previousSessionUnhealthy: false,
      secretStore: "locked",
    })
    const ensureProviderKeys = jest.fn(async () => undefined)
    useSettingsStore.getState.mockReturnValue({ loaded: true, ensureProviderKeys })
    recovery.unlockSecretStore.mockResolvedValue(state())
    const deferred = jest.fn()
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.secretStore).toBe("locked"))
    deferUntilSecretStoreReady("subscription-init", deferred)
    applyProxyToRust.mockClear()

    await act(async () => {
      await result.current.unlockSecretStore()
    })

    expect(recovery.unlockSecretStore).toHaveBeenCalledTimes(1)
    expect(result.current.secretStore).toBe("ready")
    expect(result.current.secretStoreUnlockFailed).toBe(false)
    await waitFor(() => expect(deferred).toHaveBeenCalledTimes(1))
    expect(applyProxyToRust).toHaveBeenCalledTimes(1)
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    // The unlock is not a recovery retry: checkpoints stay untouched.
    expect(recovery.retryRecoverySubsystem).not.toHaveBeenCalled()
  })

  it("keeps the store locked and flags the failure when the unlock is cancelled", async () => {
    recovery.getRecoveryBoot.mockResolvedValue({
      requiresSafeShell: false,
      mode: "normal",
      buildId: "build-1",
      previousSessionUnhealthy: false,
      secretStore: "locked",
    })
    recovery.unlockSecretStore.mockRejectedValue("SECRET_STORE_LOCKED: User canceled")
    const deferred = jest.fn()
    const { result } = renderHook(() =>
      useRecoveryGate({ createProbes: async () => healthyProbes() })
    )
    await waitFor(() => expect(result.current.secretStore).toBe("locked"))
    deferUntilSecretStoreReady("subscription-init", deferred)

    await act(async () => {
      await result.current.unlockSecretStore()
    })

    expect(result.current.secretStore).toBe("locked")
    expect(result.current.secretStoreUnlockFailed).toBe(true)
    expect(result.current.unlockingSecretStore).toBe(false)
    expect(deferred).not.toHaveBeenCalled()
  })
})
