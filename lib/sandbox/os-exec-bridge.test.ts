import type { MicrovmExecPayload, MicrovmResult } from "@cognia/plugin-sdk/api/sandbox"

import {
  __resetOsSandboxBridgeForTesting,
  disposeOsSandboxExec,
  getOsSandboxExec,
  setOsSandboxExec,
  subscribeOsSandboxAvailability,
  type OsSandboxExecutor,
} from "./os-exec-bridge"

function executor(overrides: Partial<OsSandboxExecutor> = {}): OsSandboxExecutor {
  return {
    execute: async (_payload: MicrovmExecPayload) =>
      ({
        exit_code: 0,
        stdout: "",
        stderr: "",
        duration: 0,
        timed_out: false,
      }) satisfies MicrovmResult,
    probe: async () => ({ confined: true, backend: "test", detail: "" }),
    ...overrides,
  }
}

afterEach(() => {
  __resetOsSandboxBridgeForTesting()
})

describe("os sandbox exec bridge", () => {
  it("reports no executor until a host registers one", () => {
    expect(getOsSandboxExec()).toBeNull()
  })

  it("hands back exactly the registered executor", () => {
    const impl = executor()
    setOsSandboxExec(impl)
    expect(getOsSandboxExec()).toBe(impl)
  })

  it("withdraws on null so the caller falls back to the Tauri transport", () => {
    setOsSandboxExec(executor())
    setOsSandboxExec(null)
    expect(getOsSandboxExec()).toBeNull()
  })

  it("notifies availability subscribers on register and withdraw", () => {
    const seen: Array<boolean> = []
    const unsubscribe = subscribeOsSandboxAvailability(() => {
      seen.push(getOsSandboxExec() !== null)
    })
    setOsSandboxExec(executor())
    setOsSandboxExec(null)
    unsubscribe()
    setOsSandboxExec(executor())
    expect(seen).toEqual([true, false])
  })

  it("does not notify when the same executor is registered twice", () => {
    // Bootstrap can run more than once in a long-lived host. A redundant
    // registration must not churn every availability consumer.
    const impl = executor()
    let calls = 0
    subscribeOsSandboxAvailability(() => {
      calls += 1
    })
    setOsSandboxExec(impl)
    setOsSandboxExec(impl)
    expect(calls).toBe(1)
  })

  it("disposes the active executor and clears the registry", async () => {
    let disposed = false
    setOsSandboxExec(
      executor({
        dispose: () => {
          disposed = true
        },
      })
    )
    await disposeOsSandboxExec()
    expect(disposed).toBe(true)
    expect(getOsSandboxExec()).toBeNull()
  })

  it("clears the registry before awaiting dispose so no call lands mid-teardown", async () => {
    let duringDispose: OsSandboxExecutor | null = executor()
    setOsSandboxExec(
      executor({
        dispose: async () => {
          duringDispose = getOsSandboxExec()
        },
      })
    )
    await disposeOsSandboxExec()
    expect(duringDispose).toBeNull()
  })

  it("tolerates disposing when no executor was ever registered", async () => {
    await expect(disposeOsSandboxExec()).resolves.toBeUndefined()
  })

  it("keeps subscribers alive across the test reset", () => {
    // A production subscriber registers at module load and can never
    // re-register. If the reset cleared listeners, the first test to call it
    // would silently disable `sandbox-status`'s cache invalidation for the rest
    // of the file, and later tests would read a stale memoised probe.
    let notified = 0
    subscribeOsSandboxAvailability(() => {
      notified += 1
    })
    __resetOsSandboxBridgeForTesting()
    setOsSandboxExec(executor())
    expect(notified).toBeGreaterThan(0)
  })

  it("notifies on withdrawal through the reset itself", () => {
    setOsSandboxExec(executor())
    let notified = 0
    subscribeOsSandboxAvailability(() => {
      notified += 1
    })
    __resetOsSandboxBridgeForTesting()
    expect(notified).toBe(1)
    expect(getOsSandboxExec()).toBeNull()
  })
})
