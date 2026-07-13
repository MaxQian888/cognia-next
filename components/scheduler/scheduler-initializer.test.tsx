/**
 * @jest-environment jsdom
 */

import { render, act } from "@testing-library/react"

const stopSchedulerSystem = jest.fn()
jest.mock("@/lib/scheduler", () => ({
  stopSchedulerSystem: () => stopSchedulerSystem(),
}))

const logInfo = jest.fn()
const logError = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    scheduler: {
      info: (...args: unknown[]) => logInfo(...args),
      error: (...args: unknown[]) => logError(...args),
    },
  },
}))

// The execution-event bridge is wired into the scheduler boot; mock it so the
// initializer test doesn't pull the real broker / logging chain.
const teardownBridgeMock = jest.fn()
const installBridgeMock = jest.fn(() => teardownBridgeMock)
jest.mock("@/lib/execution/event-bridge", () => ({
  installExecutionEventBridge: () => installBridgeMock(),
}))

type StoreState = {
  initialize: jest.Mock<Promise<void>, []>
  isInitialized: boolean
  setSchedulerStatus: jest.Mock<void, [string]>
}

let storeState: StoreState

jest.mock("@/stores/scheduler", () => ({
  useSchedulerStore: <T,>(selector: (s: StoreState) => T) => selector(storeState),
}))

import { SchedulerInitializer } from "./scheduler-initializer"

beforeEach(() => {
  storeState = {
    initialize: jest.fn(async () => undefined),
    isInitialized: false,
    setSchedulerStatus: jest.fn(),
  }
  stopSchedulerSystem.mockClear()
  logInfo.mockClear()
  logError.mockClear()
  installBridgeMock.mockClear()
  teardownBridgeMock.mockClear()
})

describe("SchedulerInitializer", () => {
  it("calls initialize and sets status to running on mount", async () => {
    await act(async () => {
      render(<SchedulerInitializer />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(storeState.initialize).toHaveBeenCalledTimes(1)
    expect(storeState.setSchedulerStatus).toHaveBeenCalledWith("running")
    expect(logInfo).toHaveBeenCalled()
  })

  it("logs an error and sets status to stopped when initialize fails", async () => {
    const boom = new Error("init boom")
    storeState.initialize = jest.fn(async () => {
      throw boom
    })
    await act(async () => {
      render(<SchedulerInitializer />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(logError).toHaveBeenCalled()
    expect(storeState.setSchedulerStatus).toHaveBeenCalledWith("stopped")
  })

  it("skips initialization when isInitialized is true", () => {
    storeState.isInitialized = true
    render(<SchedulerInitializer />)
    expect(storeState.initialize).not.toHaveBeenCalled()
  })

  it("stops the scheduler on unmount", async () => {
    const { unmount } = render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    expect(stopSchedulerSystem).toHaveBeenCalled()
    expect(storeState.setSchedulerStatus).toHaveBeenCalledWith("stopped")
  })

  it("installs the execution-event bridge on mount and tears it down on unmount", async () => {
    const { unmount } = render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(installBridgeMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(teardownBridgeMock).toHaveBeenCalledTimes(1)
  })

  it("captures beforeunload to stop the scheduler", async () => {
    render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    stopSchedulerSystem.mockClear()
    window.dispatchEvent(new Event("beforeunload"))
    expect(stopSchedulerSystem).toHaveBeenCalled()
  })

  it("logs an error when stopSchedulerSystem throws on unmount", async () => {
    stopSchedulerSystem.mockImplementationOnce(() => {
      throw new Error("stop boom")
    })
    const { unmount } = render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    expect(logError).toHaveBeenCalled()
  })

  it("logs an error when stopSchedulerSystem throws on beforeunload", async () => {
    render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    stopSchedulerSystem.mockImplementationOnce(() => {
      throw new Error("beforeunload boom")
    })
    window.dispatchEvent(new Event("beforeunload"))
    expect(logError).toHaveBeenCalled()
  })
})
