/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: { count?: number }): string => {
      const count = values?.count
      const messages: Record<string, string> = {
        unavailableWrite: "Skill writes are unavailable for the current host.",
        unavailableRead: "Skills are unavailable for the current host.",
        noChanges: "No changes.",
      }
      if (key === "pushed") return `${count} pushed`
      if (key === "pulled") return `${count} pulled`
      if (key === "skipped") return `${count} skipped`
      if (key === "errored") return `${count} errored`
      return messages[key] ?? key
    },
}))

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const pushMock = jest.fn()
const pullMock = jest.fn()
const pushOneMock = jest.fn()
jest.mock("@/lib/skills/sync", () => ({
  canReadHostSkills: () => isTauriMock(),
  canWriteHostSkills: () => isTauriMock(),
  pushAllToNative: () => pushMock(),
  pullAllFromNative: () => pullMock(),
  pushOneToNative: (id: string) => pushOneMock(id),
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
  pushOneMock.mockReset()
  toastSuccess.mockClear()
  toastInfo.mockClear()
  toastError.mockClear()
  toastWarning.mockClear()
})

describe("useSkillSync", () => {
  it("push/pull short-circuit when the current host lacks Skills operations", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.push()
    })
    expect(toastError).toHaveBeenCalledWith("Skill writes are unavailable for the current host.")
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

  it("pushOne short-circuits when the current host cannot write Skills", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pushOne("skill_1")
    })
    expect(toastError).toHaveBeenCalledWith("Skill writes are unavailable for the current host.")
    expect(pushOneMock).not.toHaveBeenCalled()
  })

  it("pushOne delegates to pushOneToNative and summarises success", async () => {
    pushOneMock.mockResolvedValueOnce({ pushed: 1, pulled: 0, skipped: 0, errors: [] })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pushOne("skill_1")
    })
    expect(pushOneMock).toHaveBeenCalledWith("skill_1")
    expect(toastSuccess).toHaveBeenCalledWith("1 pushed")
  })

  it("pushOne surfaces errors via toast.warning", async () => {
    pushOneMock.mockResolvedValueOnce({
      pushed: 0,
      pulled: 0,
      skipped: 0,
      errors: [{ name: "Foo", error: "disk full" }],
    })
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pushOne("skill_1")
    })
    expect(toastWarning).toHaveBeenCalledWith("1 errored")
  })

  it("pushOne thrown error toasts the message", async () => {
    pushOneMock.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() => useSkillSync())
    await act(async () => {
      await result.current.pushOne("skill_1")
    })
    expect(toastError).toHaveBeenCalledWith("network down")
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
