/**
 * @jest-environment jsdom
 */
import { act, render, renderHook } from "@testing-library/react"

import { recordRecentErrorLog, resetRecentErrorLogsForTest } from "@cognia/logging/recent-errors"
import type { StructuredLogEntry } from "@/types/logging"

import { useRecentErrorLogs } from "./use-recent-error-logs"

function entry(id: string): StructuredLogEntry {
  return {
    id,
    timestamp: "2026-06-23T10:00:00.000Z",
    level: "error",
    message: id,
    module: "test",
  } as StructuredLogEntry
}

beforeEach(() => {
  resetRecentErrorLogsForTest()
})

it("returns the buffer newest-first and keeps its identity between renders", () => {
  recordRecentErrorLog(entry("a"))
  recordRecentErrorLog(entry("b"))
  const { result, rerender } = renderHook(() => useRecentErrorLogs())
  expect(result.current.map((e) => e.id)).toEqual(["b", "a"])
  const first = result.current
  rerender()
  expect(result.current).toBe(first)
})

it("picks up a new entry once the deferred wake-up runs", async () => {
  const { result } = renderHook(() => useRecentErrorLogs())
  expect(result.current).toHaveLength(0)

  await act(async () => {
    recordRecentErrorLog(entry("later"))
    await Promise.resolve()
  })

  expect(result.current.map((e) => e.id)).toEqual(["later"])
})

// The reason this hook exists: `recordRecentErrorLog` runs on the console
// bridge's synchronous path, so a sibling that logs during its own render would
// otherwise wake an already-mounted reader mid-render.
it("survives a record raised during another component's render", () => {
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  let recorded = false

  function Reader() {
    useRecentErrorLogs()
    return null
  }
  function LogsWhileRendering({ noisy }: { noisy: boolean }) {
    if (noisy && !recorded) {
      recorded = true
      recordRecentErrorLog(entry("mid-render"))
    }
    return null
  }
  const tree = (noisy: boolean) => (
    <>
      <Reader />
      <LogsWhileRendering noisy={noisy} />
    </>
  )

  // Mounted first — the subscription only exists after commit, so the warning
  // needs a later render pass to be reachable at all.
  const { rerender } = render(tree(false))
  rerender(tree(true))

  expect(recorded).toBe(true)
  const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")
  expect(logged).not.toContain("Cannot update a component")
  errorSpy.mockRestore()
})
