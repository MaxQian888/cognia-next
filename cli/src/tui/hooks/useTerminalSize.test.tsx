import { EventEmitter } from "node:events"
import { act, renderHook } from "@testing-library/react"

import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  readSize,
  useTerminalSize,
  type ResizableStdout,
} from "./useTerminalSize"

describe("readSize", () => {
  it("reads columns/rows from a TTY stdout", () => {
    expect(readSize({ columns: 120, rows: 40 })).toEqual({ columns: 120, rows: 40 })
  })

  it("falls back to 80×24 for a non-TTY stream", () => {
    expect(readSize(undefined)).toEqual({ columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS })
    expect(readSize({})).toEqual({ columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS })
    expect(readSize({ columns: 0, rows: 0 })).toEqual({
      columns: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
    })
  })
})

/** A fake stdout that emits resize events for the reactive-hook test.
 * `EventEmitter` already supplies the `on`/`off` the hook subscribes through. */
function fakeStdout(initial: { columns: number; rows: number }): ResizableStdout & EventEmitter {
  const emitter = new EventEmitter() as ResizableStdout & EventEmitter
  emitter.columns = initial.columns
  emitter.rows = initial.rows
  return emitter
}

describe("useTerminalSize", () => {
  it("returns the initial size and updates on resize", () => {
    const stdout = fakeStdout({ columns: 100, rows: 30 })
    const { result } = renderHook(() => useTerminalSize(stdout))
    expect(result.current).toEqual({ columns: 100, rows: 30 })

    act(() => {
      stdout.columns = 64
      stdout.rows = 20
      stdout.emit("resize")
    })
    expect(result.current).toEqual({ columns: 64, rows: 20 })
  })

  it("unsubscribes the resize listener on unmount", () => {
    const stdout = fakeStdout({ columns: 100, rows: 30 })
    const { unmount } = renderHook(() => useTerminalSize(stdout))
    expect((stdout as EventEmitter).listenerCount("resize")).toBe(1)
    unmount()
    expect((stdout as EventEmitter).listenerCount("resize")).toBe(0)
  })

  it("tolerates a stdout with no event support", () => {
    const { result } = renderHook(() => useTerminalSize({ columns: 50, rows: 10 }))
    expect(result.current).toEqual({ columns: 50, rows: 10 })
  })
})
