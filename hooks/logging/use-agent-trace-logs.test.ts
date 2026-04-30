/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useAgentTraceAsLogs } from "./use-agent-trace-logs"

describe("useAgentTraceAsLogs (stub)", () => {
  it("returns the empty stub shape regardless of options", () => {
    const { result } = renderHook(() => useAgentTraceAsLogs())
    expect(result.current.logs).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("accepts options without changing the output", () => {
    const { result } = renderHook(() =>
      useAgentTraceAsLogs({ enabled: true, maxLogs: 50, includeHistory: true })
    )
    expect(result.current.logs).toEqual([])
  })

  it("returns the same `logs` reference between calls (referential stability)", () => {
    const { result, rerender } = renderHook(() => useAgentTraceAsLogs())
    const first = result.current.logs
    rerender()
    expect(result.current.logs).toBe(first)
  })
})
