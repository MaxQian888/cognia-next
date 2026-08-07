import type { PlatformAdapter } from "@/types/connectors"
import type { AuditEntryInput } from "./audit"
import { ConnectorRuntimeSupervisor, type ConnectorRuntimeDefinition } from "./runtime-supervisor"

function adapter(
  id: string,
  health: PlatformAdapter["health"] = () => ({ state: "running" })
): PlatformAdapter {
  return {
    id,
    health,
    stop: jest.fn().mockResolvedValue(undefined),
  } as unknown as PlatformAdapter
}

function definition(
  id: string,
  overrides: Partial<ConnectorRuntimeDefinition> = {}
): ConnectorRuntimeDefinition {
  return {
    id,
    owner: "adapter-instance",
    desiredState: () => "enabled",
    build: jest.fn(async () => adapter(id)),
    registerRust: jest.fn(async () => undefined),
    unregisterRust: jest.fn(async () => undefined),
    start: jest.fn(async () => undefined),
    publish: jest.fn(),
    unpublish: jest.fn(),
    ...overrides,
  }
}

describe("ConnectorRuntimeSupervisor", () => {
  it("coalesces simultaneous restart causes into the latest generation", async () => {
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    const runtime = definition("adapter-1")
    supervisor.setDefinition(runtime)

    await Promise.all([
      supervisor.restartAdapter("adapter-1", "manual_restart"),
      supervisor.restartAdapter("adapter-1", "credentials_rotated"),
      supervisor.restartAdapter("adapter-1", "hot_reconcile"),
    ])

    expect(runtime.build).toHaveBeenCalledTimes(1)
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      observedState: "running",
      generation: 3,
      reasonCode: "hot_reconcile",
    })
  })

  it("fences an old start result before publishing the replacement", async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStart = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const first = adapter("adapter-1")
    const second = adapter("adapter-1")
    const runtime = definition("adapter-1", {
      build: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      start: jest
        .fn()
        .mockImplementationOnce(() => {
          markFirstStarted()
          return firstStart
        })
        .mockResolvedValueOnce(undefined),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)

    const old = supervisor.restartAdapter("adapter-1", "initial")
    await firstStarted
    const latest = supervisor.restartAdapter("adapter-1", "credentials_rotated")
    releaseFirst()
    await Promise.all([old, latest])

    expect(runtime.publish).toHaveBeenCalledTimes(1)
    expect(runtime.publish).toHaveBeenCalledWith(second, 2)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.getSnapshot("adapter-1")?.generation).toBe(2)
  })

  it("does not publish an aborted old generation as failed", async () => {
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const snapshots: Array<{ generation: number; observedState: string }> = []
    const runtime = definition("adapter-1", {
      start: jest
        .fn()
        .mockImplementationOnce((_adapter, signal: AbortSignal) => {
          markFirstStarted()
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
        })
        .mockResolvedValueOnce(undefined),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.subscribe((snapshot) => snapshots.push(snapshot))
    supervisor.setDefinition(runtime)

    const old = supervisor.restartAdapter("adapter-1", "initial")
    await firstStarted
    const latest = supervisor.restartAdapter("adapter-1", "credentials_rotated")
    await Promise.all([old, latest])

    expect(
      snapshots.some(
        (snapshot) => snapshot.generation === 1 && snapshot.observedState === "failed"
      )
    ).toBe(false)
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      generation: 2,
      observedState: "running",
    })
  })

  it("does not start a replacement when stale-generation cleanup fails", async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStart = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const first = adapter("adapter-1")
    first.stop = jest.fn().mockRejectedValue(new Error("stop failed"))
    const runtime = definition("adapter-1", {
      build: jest.fn().mockResolvedValue(first),
      start: jest.fn().mockImplementationOnce(() => {
        markFirstStarted()
        return firstStart
      }),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)

    const old = supervisor.restartAdapter("adapter-1", "initial")
    await firstStarted
    const latest = supervisor.restartAdapter("adapter-1", "credentials_rotated")
    releaseFirst()
    await Promise.all([old, latest])

    expect(runtime.build).toHaveBeenCalledTimes(1)
    expect(runtime.publish).not.toHaveBeenCalled()
    expect(supervisor.getRunningAdapter("adapter-1")?.adapter).toBe(first)
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      generation: 2,
      observedState: "failed",
      reasonCode: "stop_failed",
    })
  })

  it.each([
    ["running", "running", true],
    ["starting", "starting", false],
    ["degraded", "degraded", false],
  ] as const)("publishes truthful %s health as %s", async (health, observed, startedAudit) => {
    const audit = jest.fn(async (_entry: AuditEntryInput) => undefined)
    const runtime = definition("adapter-1", {
      build: jest.fn(async () => adapter("adapter-1", () => ({ state: health }))),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit })
    supervisor.setDefinition(runtime)

    await supervisor.reconcileAdapter("adapter-1", "initial")

    expect(supervisor.getSnapshot("adapter-1")?.observedState).toBe(observed)
    expect(audit.mock.calls.some(([entry]) => entry.kind === "adapter.started")).toBe(startedAudit)
  })

  it("treats down health as startup failure and never publishes", async () => {
    const runtime = definition("adapter-1", {
      build: jest.fn(async () => adapter("adapter-1", () => ({ state: "down" }))),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)

    await supervisor.reconcileAdapter("adapter-1", "initial")

    expect(runtime.publish).not.toHaveBeenCalled()
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      observedState: "failed",
      reasonCode: "health_down",
    })
  })

  it("fails closed on stop timeout and does not build a replacement", async () => {
    const never = new Promise<void>(() => undefined)
    const running = adapter("adapter-1")
    running.stop = jest.fn(() => never)
    const runtime = definition("adapter-1")
    const supervisor = new ConnectorRuntimeSupervisor({ stopTimeoutMs: 5, audit: jest.fn() })
    supervisor.setDefinition(runtime)
    supervisor.adoptRunningAdapter(runtime, running, new AbortController(), 1)
    jest.mocked(runtime.build).mockClear()

    await supervisor.restartAdapter("adapter-1", "manual_restart")

    expect(runtime.build).not.toHaveBeenCalled()
    expect(supervisor.getRunningAdapter("adapter-1")?.adapter).toBe(running)
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      observedState: "failed",
      reasonCode: "stop_timeout",
    })
  })

  it("keeps retrying cleanup instead of double-starting after a stop failure", async () => {
    const running = adapter("adapter-1")
    running.stop = jest.fn().mockRejectedValue(new Error("stop failed"))
    const runtime = definition("adapter-1")
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)
    supervisor.adoptRunningAdapter(runtime, running, new AbortController(), 1)
    jest.mocked(runtime.build).mockClear()

    await supervisor.restartAdapter("adapter-1", "manual_restart")
    await supervisor.restartAdapter("adapter-1", "credentials_rotated")

    expect(running.stop).toHaveBeenCalledTimes(2)
    expect(runtime.build).not.toHaveBeenCalled()
    expect(supervisor.getRunningAdapter("adapter-1")?.adapter).toBe(running)
  })

  it("retains a disabled definition until failed removal cleanup can retry", async () => {
    const running = adapter("adapter-1")
    running.stop = jest
      .fn()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValueOnce(undefined)
    const runtime = definition("adapter-1")
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)
    supervisor.adoptRunningAdapter(runtime, running, new AbortController(), 1)

    await supervisor.removeDefinition("adapter-1", "runtime_disabled")
    expect(supervisor.hasDefinition("adapter-1")).toBe(true)
    expect(supervisor.getRunningAdapter("adapter-1")?.adapter).toBe(running)

    await supervisor.reconcileAdapter("adapter-1", "cleanup_retry")
    expect(supervisor.hasDefinition("adapter-1")).toBe(false)
    expect(supervisor.getRunningAdapter("adapter-1")).toBeUndefined()
  })

  it("does not delete a replacement definition that races a removal", async () => {
    let releaseStop!: () => void
    let markStopStarted!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve
    })
    const running = adapter("adapter-1")
    running.stop = jest.fn(() => {
      markStopStarted()
      return stopGate
    })
    const original = definition("adapter-1")
    const replacement = definition("adapter-1")
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.adoptRunningAdapter(original, running, new AbortController(), 1)

    const removal = supervisor.removeDefinition("adapter-1", "runtime_disabled")
    await stopStarted
    supervisor.setDefinition(replacement)
    const reenable = supervisor.reconcileAdapter("adapter-1", "runtime_reenabled")
    releaseStop()
    await Promise.all([removal, reenable])

    expect(supervisor.hasDefinition("adapter-1")).toBe(true)
    expect(replacement.build).toHaveBeenCalledTimes(1)
    expect(supervisor.getSnapshot("adapter-1")).toMatchObject({
      observedState: "running",
      reasonCode: "runtime_reenabled",
    })
  })

  it("refreshes starting health to running without rebuilding", async () => {
    let state: "starting" | "running" = "starting"
    const runtime = definition("adapter-1", {
      build: jest.fn(async () => adapter("adapter-1", () => ({ state }))),
    })
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn() })
    supervisor.setDefinition(runtime)
    await supervisor.reconcileAdapter("adapter-1", "initial")

    state = "running"
    const snapshot = supervisor.refreshHealth("adapter-1", "heartbeat")

    expect(snapshot).toMatchObject({ observedState: "running", reasonCode: "heartbeat" })
    expect(runtime.build).toHaveBeenCalledTimes(1)
  })

  it("never starts more than four adapters concurrently", async () => {
    let active = 0
    let maxActive = 0
    const supervisor = new ConnectorRuntimeSupervisor({ audit: jest.fn(), startConcurrency: 4 })
    for (let index = 0; index < 12; index++) {
      const id = `adapter-${index}`
      supervisor.setDefinition(
        definition(id, {
          start: async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
            active -= 1
          },
        })
      )
    }

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        supervisor.reconcileAdapter(`adapter-${index}`, "initial")
      )
    )

    expect(maxActive).toBeLessThanOrEqual(4)
  })
})
