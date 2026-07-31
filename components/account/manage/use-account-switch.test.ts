/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useAccountSwitch } from "./use-account-switch"

const switchAccountMock = jest.fn<Promise<void>, [string, string?]>()

let mockState: {
  activeAccountId: string | null
  unlockedAccountId: string | null
  switchAccount: typeof switchAccountMock
}

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

beforeEach(() => {
  jest.clearAllMocks()
  switchAccountMock.mockResolvedValue()
  mockState = {
    activeAccountId: "acct_active",
    unlockedAccountId: "acct_active",
    switchAccount: switchAccountMock,
  }
})

describe("useAccountSwitch", () => {
  it("treats switching to the active account as a no-op", async () => {
    const { result } = renderHook(() => useAccountSwitch())
    let completed: boolean | undefined
    await act(async () => {
      completed = await result.current.begin("acct_active")
    })
    expect(completed).toBe(true)
    expect(result.current.pendingId).toBeNull()
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("opens a password prompt for a locked account", async () => {
    const { result } = renderHook(() => useAccountSwitch())
    let completed: boolean | undefined
    await act(async () => {
      completed = await result.current.begin("acct_other")
    })
    expect(completed).toBe(false)
    expect(result.current.pendingId).toBe("acct_other")
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("switches passwordlessly for an already-unlocked but inactive account", async () => {
    mockState.unlockedAccountId = "acct_unlocked"
    const onSwitched = jest.fn()
    const { result } = renderHook(() => useAccountSwitch({ onSwitched }))
    await act(async () => {
      await result.current.begin("acct_unlocked")
    })
    expect(switchAccountMock).toHaveBeenCalledWith("acct_unlocked", undefined)
    expect(onSwitched).toHaveBeenCalledWith("acct_unlocked")
    expect(result.current.pendingId).toBeNull()
  })

  it("confirms a pending switch with the entered password and resets", async () => {
    const onSwitched = jest.fn()
    const { result } = renderHook(() => useAccountSwitch({ onSwitched }))
    await act(async () => {
      await result.current.begin("acct_other")
    })
    act(() => result.current.setPassword("hunter2"))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.confirm()
    })
    expect(ok).toBe(true)
    expect(switchAccountMock).toHaveBeenCalledWith("acct_other", "hunter2")
    expect(onSwitched).toHaveBeenCalledWith("acct_other")
    expect(result.current.pendingId).toBeNull()
    expect(result.current.password).toBe("")
  })

  it("surfaces the error and keeps the prompt open on failure", async () => {
    switchAccountMock.mockRejectedValueOnce(new Error("Invalid local account password."))
    const { result } = renderHook(() => useAccountSwitch())
    await act(async () => {
      await result.current.begin("acct_other")
    })
    act(() => result.current.setPassword("wrong"))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.confirm()
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe("Invalid local account password.")
    expect(result.current.pendingId).toBe("acct_other")
  })

  it("falls back to the provided label for non-Error throwables", async () => {
    switchAccountMock.mockRejectedValueOnce({ code: "nope" })
    const { result } = renderHook(() =>
      useAccountSwitch({ operationFailedLabel: "operation failed" })
    )
    await act(async () => {
      await result.current.begin("acct_other")
    })
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.error).toBe("operation failed")
  })

  it("confirm without a pending switch is a no-op", async () => {
    const { result } = renderHook(() => useAccountSwitch())
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.confirm()
    })
    expect(ok).toBe(false)
    expect(switchAccountMock).not.toHaveBeenCalled()
  })

  it("cancel clears the pending prompt", async () => {
    const { result } = renderHook(() => useAccountSwitch())
    await act(async () => {
      await result.current.begin("acct_other")
    })
    act(() => result.current.setPassword("x"))
    act(() => result.current.cancel())
    expect(result.current.pendingId).toBeNull()
    expect(result.current.password).toBe("")
    expect(result.current.error).toBeNull()
  })
})
