/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const pushMock = jest.fn()
const pullMock = jest.fn()
jest.mock("@/lib/skills/sync", () => ({
  pushAllToNative: () => pushMock(),
  pullAllFromNative: () => pullMock(),
}))

const toastSuccess = jest.fn()
const toastInfo = jest.fn()
const toastError = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}))

import { useSkillSync } from "./use-skill-sync"

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  pushMock.mockReset()
  pullMock.mockReset()
  toastSuccess.mockClear()
  toastInfo.mockClear()
  toastError.mockClear()
  toastWarning.mockClear()
})

describe("useSkillSync", () => {
  it("push/pull short-circuit outside Tauri with an error toast", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.push()
    })
    expect(toastError).toHaveBeenCalledWith("Sync requires desktop mode.")
    await act(async () => {
      await result.current.pull()
    })
    expect(toastError).toHaveBeenCalledTimes(2)
    expect(pushMock).not.toHaveBeenCalled()
    expect(pullMock).not.toHaveBeenCalled()
  })

  it("push success summarises as 'X pushed'", async () => {
    pushMock.mockResolvedValueOnce({ pushed: 3, pulled: 0, skipped: 0, errors: [] })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.push()
    })
    expect(toastSuccess).toHaveBeenCalledWith("3 pushed")
  })

  it("pull success summarises as 'X pulled'", async () => {
    pullMock.mockResolvedValueOnce({ pushed: 0, pulled: 5, skipped: 0, errors: [] })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pull()
    })
    expect(toastSuccess).toHaveBeenCalledWith("5 pulled")
  })

  it("zero-change result toasts info", async () => {
    pushMock.mockResolvedValueOnce({ pushed: 0, pulled: 0, skipped: 0, errors: [] })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.push()
    })
    expect(toastInfo).toHaveBeenCalledWith("No changes.")
  })

  it("errors in result toast warning", async () => {
    pullMock.mockResolvedValueOnce({
      pushed: 0,
      pulled: 1,
      skipped: 2,
      errors: ["err1"],
    })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pull()
    })
    expect(toastWarning).toHaveBeenCalledWith("1 pulled, 2 skipped, 1 errored")
  })

  it("a thrown sync error toasts the error message", async () => {
    pushMock.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.push()
    })
    expect(toastError).toHaveBeenCalledWith("network down")
  })

  it("non-Error throws are stringified into the toast", async () => {
    pullMock.mockRejectedValueOnce("string-failure")
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pull()
    })
    expect(toastError).toHaveBeenCalledWith("string-failure")
  })

  it("busy toggles around the action", async () => {
    let resolvePush: () => void = () => undefined
    pushMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePush = () => r({ pushed: 1, pulled: 0, skipped: 0, errors: [] })
        })
    )
    const { result } = renderHook(() => useSkillSync())
    let promise: Promise<void>
    act(() => {
      promise = result.current.push()
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
      resolvePush()
      await promise!
    })
    expect(result.current.busy).toBe(false)
  })
})
