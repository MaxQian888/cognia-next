import { render, waitFor } from "@testing-library/react"

import { WorkerRuntimeInitializer } from "./worker-runtime-initializer"

const attachTauriWorkerRuntime = jest.fn()
const getActiveAccountId = jest.fn(() => "local_acct_a")
const accountState = { accountRevision: 0 }

jest.mock("@/lib/ai/agent/team/tauri-worker-runtime", () => ({
  attachTauriWorkerRuntime: (...args: unknown[]) => attachTauriWorkerRuntime(...args),
}))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => getActiveAccountId(),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof accountState) => unknown) => selector(accountState),
}))

describe("WorkerRuntimeInitializer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    attachTauriWorkerRuntime.mockReset()
    accountState.accountRevision = 0
    getActiveAccountId.mockReturnValue("local_acct_a")
  })

  it("rebinds the runtime after the active account database changes", async () => {
    const disposeFirst = jest.fn(async () => undefined)
    const disposeSecond = jest.fn(async () => undefined)
    attachTauriWorkerRuntime
      .mockResolvedValueOnce({ pool: {}, dispose: disposeFirst })
      .mockResolvedValueOnce({ pool: {}, dispose: disposeSecond })

    const { rerender, unmount } = render(<WorkerRuntimeInitializer />)
    await waitFor(() => expect(attachTauriWorkerRuntime).toHaveBeenCalledTimes(1))

    getActiveAccountId.mockReturnValue("acct_b")
    accountState.accountRevision += 1
    rerender(<WorkerRuntimeInitializer />)

    await waitFor(() => expect(disposeFirst).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(attachTauriWorkerRuntime).toHaveBeenLastCalledWith({ tenantId: "acct_b" })
    )

    unmount()
    await waitFor(() => expect(disposeSecond).toHaveBeenCalledTimes(1))
  })

  it("still attaches the new tenant when the old runtime cannot dispose cleanly", async () => {
    const debug = jest.spyOn(console, "debug").mockImplementation(() => undefined)
    attachTauriWorkerRuntime
      .mockResolvedValueOnce({
        pool: {},
        dispose: jest.fn(async () => {
          throw new Error("already detached")
        }),
      })
      .mockResolvedValueOnce({ pool: {}, dispose: jest.fn(async () => undefined) })

    const { rerender } = render(<WorkerRuntimeInitializer />)
    await waitFor(() => expect(attachTauriWorkerRuntime).toHaveBeenCalledTimes(1))
    getActiveAccountId.mockReturnValue("acct_b")
    accountState.accountRevision += 1
    rerender(<WorkerRuntimeInitializer />)

    await waitFor(() =>
      expect(attachTauriWorkerRuntime).toHaveBeenLastCalledWith({ tenantId: "acct_b" })
    )
    debug.mockRestore()
  })

  it("attaches the worker runtime once for the active account", async () => {
    const dispose = jest.fn(async () => undefined)
    attachTauriWorkerRuntime.mockResolvedValue({ pool: {}, dispose })

    const { rerender, unmount } = render(<WorkerRuntimeInitializer />)
    rerender(<WorkerRuntimeInitializer />)

    await waitFor(() => expect(attachTauriWorkerRuntime).toHaveBeenCalledTimes(1))
    expect(attachTauriWorkerRuntime).toHaveBeenCalledWith({ tenantId: "local_acct_a" })

    unmount()
    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  })

  it("disposes a runtime that resolved after unmount instead of leaking it", async () => {
    // The host keeps the attached channel until something detaches it, so an
    // attach that lands after teardown would otherwise leave a dead brain
    // holding the sink and starve the next one.
    let resolveAttach: ((value: unknown) => void) | undefined
    const dispose = jest.fn(async () => undefined)
    attachTauriWorkerRuntime.mockReturnValue(
      new Promise((resolve) => {
        resolveAttach = resolve
      })
    )

    const { unmount } = render(<WorkerRuntimeInitializer />)
    await waitFor(() => expect(attachTauriWorkerRuntime).toHaveBeenCalledTimes(1))
    unmount()
    resolveAttach?.({ pool: {}, dispose })

    await waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
  })

  it("stays silent when the host has no worker ingress to attach to", async () => {
    // A desktop build whose companion server was never started is an ordinary
    // configuration, not a fault — the Fleet card is what reports it.
    attachTauriWorkerRuntime.mockRejectedValue(new Error("companion server is not running"))
    const debug = jest.spyOn(console, "debug").mockImplementation(() => undefined)

    expect(() => render(<WorkerRuntimeInitializer />)).not.toThrow()
    await waitFor(() => expect(debug).toHaveBeenCalled())

    debug.mockRestore()
  })
})
