const hasGitBridgeMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("./commands", () => ({
  hasGitBridge: () => hasGitBridgeMock(),
}))

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
  },
}))

import { GIT_STATUS_CHANGED_EVENT, subscribeGitStatusChanged } from "./events"

beforeEach(() => {
  hasGitBridgeMock.mockReset()
  subscribeMock.mockReset()
  jest.useRealTimers()
})

describe("subscribeGitStatusChanged", () => {
  it("returns a no-op unsubscribe on an unpaired browser", () => {
    hasGitBridgeMock.mockReturnValue(false)
    const unsub = subscribeGitStatusChanged(() => {})
    expect(subscribeMock).not.toHaveBeenCalled()
    expect(() => unsub()).not.toThrow()
  })

  it("subscribes to the status-changed channel whenever a git bridge exists", () => {
    hasGitBridgeMock.mockReturnValue(true)
    subscribeMock.mockReturnValue(() => {})
    subscribeGitStatusChanged(() => {})
    expect(subscribeMock).toHaveBeenCalledWith(GIT_STATUS_CHANGED_EVENT, expect.any(Function))
  })

  it("coalesces a burst into a single handler call with the latest payload", () => {
    jest.useFakeTimers()
    hasGitBridgeMock.mockReturnValue(true)
    let emit: (p: { rootDir: string }) => void = () => {}
    subscribeMock.mockImplementation((_event: string, cb: (p: { rootDir: string }) => void) => {
      emit = cb
      return () => {}
    })
    const handler = jest.fn()
    subscribeGitStatusChanged(handler, 100)

    emit({ rootDir: "/a" })
    emit({ rootDir: "/b" })
    expect(handler).not.toHaveBeenCalled()
    jest.advanceTimersByTime(100)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ rootDir: "/b" })
  })

  it("unsubscribe clears a pending timer", () => {
    jest.useFakeTimers()
    hasGitBridgeMock.mockReturnValue(true)
    let emit: (p: { rootDir: string }) => void = () => {}
    const innerUnsub = jest.fn()
    subscribeMock.mockImplementation((_e: string, cb: (p: { rootDir: string }) => void) => {
      emit = cb
      return innerUnsub
    })
    const handler = jest.fn()
    const unsub = subscribeGitStatusChanged(handler, 100)
    emit({ rootDir: "/a" })
    unsub()
    jest.advanceTimersByTime(200)
    expect(handler).not.toHaveBeenCalled()
    expect(innerUnsub).toHaveBeenCalled()
  })
})
