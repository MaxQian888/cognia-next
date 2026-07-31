/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useLogIngest } from "./use-log-ingest"
import type { LogIngestSubscriptions } from "../runtime/log-ingest"
import type { TuiAction } from "../state/types"

function fakeSubs() {
  const offs = { stderr: jest.fn(), state: jest.fn(), exit: jest.fn() }
  const subs = {
    onStdout: () => Promise.resolve(jest.fn()),
    onStderr: () => Promise.resolve(offs.stderr),
    onStateChange: () => Promise.resolve(offs.state),
    onExit: () => Promise.resolve(offs.exit),
  } as unknown as LogIngestSubscriptions
  return { subs, offs }
}

const line = { ts: 1, level: "info", channel: "agent", message: "m" } as const

describe("useLogIngest", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("coalesces many pushes into ONE LOG_APPEND_BATCH dispatch", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs } = fakeSubs()
    const { result } = renderHook(() => useLogIngest({ dispatch, subs, intervalMs: 50 }))

    act(() => {
      for (let i = 0; i < 50; i++) result.current.pushLog({ ...line, message: `m${i}` })
    })
    expect(dispatch).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0]
    expect(action.type).toBe("LOG_APPEND_BATCH")
    expect(action).toMatchObject({ entries: expect.any(Array) })
    expect((action as { entries: unknown[] }).entries).toHaveLength(50)
  })

  it("clearLogs discards in-flight lines, then dispatches LOG_CLEAR", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs } = fakeSubs()
    const { result } = renderHook(() => useLogIngest({ dispatch, subs, intervalMs: 50 }))

    act(() => {
      result.current.pushLog(line)
      result.current.clearLogs()
    })
    act(() => {
      jest.advanceTimersByTime(200)
    })
    // Exactly one dispatch: the clear. The queued line must NOT resurface.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].type).toBe("LOG_CLEAR")
  })

  it("stops dispatching after unmount", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs } = fakeSubs()
    const { result, unmount } = renderHook(() => useLogIngest({ dispatch, subs, intervalMs: 50 }))

    act(() => {
      result.current.pushLog(line)
    })
    unmount()
    act(() => {
      jest.advanceTimersByTime(200)
    })
    // Dispatching into an unmounted reducer would be a React warning.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("unsubscribes the external-agent channels on unmount", async () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs, offs } = fakeSubs()
    const { unmount } = renderHook(() => useLogIngest({ dispatch, subs }))
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    expect(offs.stderr).toHaveBeenCalled()
  })

  it("forwards injected timers and captureStdout through to the ingest layer", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs } = fakeSubs()
    // Exercises the "option explicitly provided" arms of the optional-prop
    // spreads, which the other tests only hit in their omitted form.
    const set = jest.fn((cb: () => void) => {
      cb()
      return 1 as unknown as ReturnType<typeof setTimeout>
    })
    const timers = { set, clear: jest.fn() }
    const { result } = renderHook(() =>
      useLogIngest({ dispatch, subs, timers, intervalMs: 10, captureStdout: true })
    )
    act(() => {
      result.current.pushLog(line)
    })
    expect(set).toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].type).toBe("LOG_APPEND_BATCH")
  })

  it("keeps one stable coalescer across re-renders", () => {
    const dispatch = jest.fn<void, [TuiAction]>()
    const { subs } = fakeSubs()
    const { result, rerender } = renderHook(() => useLogIngest({ dispatch, subs, intervalMs: 50 }))

    const first = result.current.pushLog
    act(() => {
      result.current.pushLog(line)
    })
    rerender()
    // A coalescer rebuilt per render would drop the line queued before it.
    expect(result.current.pushLog).toBe(first)
    act(() => {
      jest.advanceTimersByTime(50)
    })
    expect((dispatch.mock.calls[0][0] as { entries: unknown[] }).entries).toHaveLength(1)
  })
})
