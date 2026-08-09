/**
 * @jest-environment jsdom
 */

import { StrictMode } from "react"
import { render, act } from "@testing-library/react"

const stopSchedulerSystem = jest.fn()
jest.mock("@/lib/scheduler", () => ({
  stopSchedulerSystem: () => stopSchedulerSystem(),
}))
const reconcileAgentTaskRuntime = jest.fn(async () => ({ interrupted: [], settled: [] }))
jest.mock("@/lib/agent-tasks/runtime", () => ({
  reconcileAgentTaskRuntime: () => reconcileAgentTaskRuntime(),
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
const storeListeners = new Set<() => void>()

jest.mock("@/stores/scheduler", () => ({
  useSchedulerStore: <T,>(selector: (s: StoreState) => T) => {
    const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react")
    return useSyncExternalStore(
      (listener) => {
        storeListeners.add(listener)
        return () => storeListeners.delete(listener)
      },
      () => selector(storeState),
      () => selector(storeState)
    )
  },
}))

import { SchedulerInitializer } from "./scheduler-initializer"

beforeEach(() => {
  storeListeners.clear()
  storeState = {
    initialize: jest.fn(async () => undefined),
    isInitialized: false,
    setSchedulerStatus: jest.fn((status) => {
      if (status !== "stopped" || !storeState.isInitialized) return
      storeState = { ...storeState, isInitialized: false }
      storeListeners.forEach((listener) => listener())
    }),
  }
  stopSchedulerSystem.mockClear()
  reconcileAgentTaskRuntime.mockClear()
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
    expect(reconcileAgentTaskRuntime).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalled()
  })

  it("does not stop the live scheduler during the StrictMode effect replay", async () => {
    const view = render(
      <StrictMode>
        <SchedulerInitializer />
      </StrictMode>
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The effect body is replayed, while the real store deduplicates both
    // calls through its shared in-flight initialization promise.
    expect(storeState.initialize).toHaveBeenCalledTimes(2)
    expect(stopSchedulerSystem).not.toHaveBeenCalled()

    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it("does not stop when the store transitions to initialized", async () => {
    const view = render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })

    storeState.isInitialized = true
    view.rerender(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(stopSchedulerSystem).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })
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
    await act(async () => {
      unmount()
      await Promise.resolve()
    })
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
    await act(async () => {
      await Promise.resolve()
    })
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

  it("does not update scheduler subscribers during another component's render", async () => {
    function Router({ isNavigating }: { isNavigating: boolean }) {
      if (isNavigating) window.dispatchEvent(new Event("beforeunload"))
      return null
    }

    storeState.isInitialized = true
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const view = render(
      <>
        <SchedulerInitializer />
        <Router isNavigating={false} />
      </>
    )

    view.rerender(
      <>
        <SchedulerInitializer />
        <Router isNavigating />
      </>
    )

    const warnings = consoleError.mock.calls.flat().join(" ")
    consoleError.mockRestore()
    expect(warnings).not.toContain("Cannot update a component")
  })

  it("logs an error when stopSchedulerSystem throws on unmount", async () => {
    stopSchedulerSystem.mockImplementationOnce(() => {
      throw new Error("stop boom")
    })
    const { unmount } = render(<SchedulerInitializer />)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      unmount()
      await Promise.resolve()
    })
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
