import { RemoteWorkerWaitingError } from "./remote-worker-runtime"
import { requestWorkerWake, shouldAttemptWake } from "./wake-worker"

describe("shouldAttemptWake", () => {
  it("fires for absence, not for incompatibility", () => {
    // Waking a machine whose runtime does not match the spec changes nothing —
    // it would come back and still be rejected.
    expect(shouldAttemptWake(new RemoteWorkerWaitingError("pinned_host_offline", "device:a"))).toBe(
      true
    )
    expect(
      shouldAttemptWake(
        new RemoteWorkerWaitingError("no_compatible_capacity", "device:a", "worker_offline")
      )
    ).toBe(true)
    expect(shouldAttemptWake(new Error("something else"))).toBe(false)
    expect(shouldAttemptWake(undefined)).toBe(false)
  })
})

describe("requestWorkerWake", () => {
  it("asks the host to send a magic packet for the named worker", async () => {
    const invoke = jest.fn(async () => true)

    await expect(
      requestWorkerWake({ tenantId: "local_acct_a", hostRef: "device:a", invoke: invoke as never })
    ).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith("companion_wake_worker", {
      tenantId: "local_acct_a",
      hostRef: "device:a",
    })
  })

  it("reports false instead of failing the dispatch when no wake is possible", async () => {
    // Non-Tauri shells, hosts with no presence record, and workers that never
    // advertised a MAC all land here. None of them is a dispatch failure.
    const invoke = jest.fn(async () => {
      throw new Error("no worker presence for device:a")
    })

    await expect(
      requestWorkerWake({ tenantId: "local_acct_a", hostRef: "device:a", invoke: invoke as never })
    ).resolves.toBe(false)
  })

  it("does not call the host without a target", async () => {
    const invoke = jest.fn()

    await expect(
      requestWorkerWake({ tenantId: "local_acct_a", hostRef: "", invoke: invoke as never })
    ).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
})
