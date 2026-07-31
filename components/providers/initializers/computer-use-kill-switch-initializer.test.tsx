/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

const clearAllSessionGrants = jest.fn()
jest.mock("@/lib/claude/computer-use-session-grants", () => ({
  clearAllSessionGrants: () => clearAllSessionGrants(),
}))

const toastWarning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (...a: unknown[]) => toastWarning(...a) } }))

// Route the real safeUnlisten so we assert the crash-prone unlisten is swallowed.
const safeUnlisten = jest.fn()
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: unknown) => safeUnlisten(fn),
}))

import { ComputerUseKillSwitchInitializer } from "./computer-use-kill-switch-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("ComputerUseKillSwitchInitializer", () => {
  it("renders nothing", () => {
    listenMock.mockResolvedValue(() => {})
    const { container } = render(<ComputerUseKillSwitchInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("does not subscribe off the Tauri desktop", async () => {
    isTauriMock.mockReturnValue(false)
    render(<ComputerUseKillSwitchInitializer />)
    await Promise.resolve()
    expect(listenMock).not.toHaveBeenCalled()
  })

  it("subscribes to the kill-switch channel on the desktop", async () => {
    listenMock.mockResolvedValue(() => {})
    render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() =>
      expect(listenMock).toHaveBeenCalledWith("automation:kill-switch", expect.any(Function))
    )
  })

  it("clears session grants and toasts when the kill switch fires", async () => {
    let handler: (() => void) | undefined
    listenMock.mockImplementation(async (_event: string, cb: () => void) => {
      handler = cb
      return () => {}
    })
    render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() => expect(handler).toBeDefined())
    handler!()
    expect(clearAllSessionGrants).toHaveBeenCalledTimes(1)
    expect(toastWarning).toHaveBeenCalledWith("Automation kill switch engaged", expect.any(Object))
  })

  it("routes the unlisten through safeUnlisten on unmount", async () => {
    const rawUnlisten = jest.fn()
    listenMock.mockResolvedValue(rawUnlisten)
    const { unmount } = render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() => expect(listenMock).toHaveBeenCalled())
    unmount()
    expect(safeUnlisten).toHaveBeenCalledWith(rawUnlisten)
    // The raw, crash-prone unlisten is never invoked directly.
    expect(rawUnlisten).not.toHaveBeenCalled()
  })

  it("safe-unlistens the late-resolving handle when unmounted before subscribe settles", async () => {
    const rawUnlisten = jest.fn()
    let resolveListen: ((u: () => void) => void) | undefined
    listenMock.mockReturnValue(
      new Promise<() => void>((res) => {
        resolveListen = res
      })
    )
    const { unmount } = render(<ComputerUseKillSwitchInitializer />)
    // Unmount before listen() settles — the StrictMode/early-cancel race.
    unmount()
    resolveListen!(rawUnlisten)
    await waitFor(() => expect(safeUnlisten).toHaveBeenCalledWith(rawUnlisten))
    expect(rawUnlisten).not.toHaveBeenCalled()
  })
})
