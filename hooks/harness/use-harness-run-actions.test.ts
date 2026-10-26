/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const control = {
  cancelHarnessRun: jest.fn(),
  resumeHarnessRun: jest.fn(),
  approveHarnessRun: jest.fn(),
  rejectHarnessRun: jest.fn(),
  rollbackHarnessRun: jest.fn(),
}
jest.mock("@/lib/harness/runtime/run-control", () => control)
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

import { toast } from "sonner"
import { useHarnessRunActions } from "./use-harness-run-actions"

beforeEach(() => {
  for (const fn of Object.values(control)) fn.mockReset().mockResolvedValue(undefined)
  ;(toast.error as jest.Mock).mockReset()
  ;(toast.success as jest.Mock).mockReset()
})

describe("useHarnessRunActions", () => {
  it("runs each verb on the run and confirms it", async () => {
    const { result } = renderHook(() => useHarnessRunActions("run-1"))
    await act(() => result.current.approve({ setAsWorkspaceDefault: true }))
    expect(control.approveHarnessRun).toHaveBeenCalledWith("run-1", { setAsWorkspaceDefault: true })
    expect(toast.success).toHaveBeenCalledWith("Change approved and applied.")
    await act(() => result.current.reject())
    await act(() => result.current.cancel())
    await act(() => result.current.rollback())
    expect(control.rejectHarnessRun).toHaveBeenCalledWith("run-1")
    expect(control.cancelHarnessRun).toHaveBeenCalledWith("run-1")
    expect(control.rollbackHarnessRun).toHaveBeenCalledWith("run-1")
    expect(result.current.busy).toBeNull()
  })

  it("hands a resume to the driver without waiting for the run", async () => {
    let finish!: () => void
    control.resumeHarnessRun.mockReturnValue(new Promise<void>((r) => (finish = r)))
    const { result } = renderHook(() => useHarnessRunActions("run-1"))
    await act(() => result.current.resume())
    expect(control.resumeHarnessRun).toHaveBeenCalledWith("run-1")
    expect(toast.success).toHaveBeenCalledWith("Run resumed.")
    finish()
  })

  it("localizes coded failures and passes other messages through", async () => {
    control.approveHarnessRun.mockRejectedValue(
      Object.assign(new Error("x"), { name: "HarnessRunControlError", code: "not-awaiting" })
    )
    control.rollbackHarnessRun.mockRejectedValue(
      Object.assign(new Error("x"), { name: "HarnessAdoptionError", code: "already-rolled-back" })
    )
    control.cancelHarnessRun.mockRejectedValue(new Error("db closed"))
    const { result } = renderHook(() => useHarnessRunActions("run-1"))
    await act(() => result.current.approve({ setAsWorkspaceDefault: false }))
    expect(toast.error).toHaveBeenLastCalledWith("Could not apply the change.", {
      description: expect.stringMatching(/not waiting for approval/),
    })
    await act(() => result.current.rollback())
    expect(toast.error).toHaveBeenLastCalledWith("Could not roll back.", {
      description: "This adoption was already rolled back.",
    })
    await act(() => result.current.cancel())
    expect(toast.error).toHaveBeenLastCalledWith("Could not cancel the run.", {
      description: "db closed",
    })
  })

  it("does nothing without a run", async () => {
    const { result } = renderHook(() => useHarnessRunActions(undefined))
    await act(() => result.current.cancel())
    expect(control.cancelHarnessRun).not.toHaveBeenCalled()
  })
})
