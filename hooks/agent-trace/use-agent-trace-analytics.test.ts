import { renderHook, act } from "@testing-library/react"

import { useAgentTraceAnalytics } from "./use-agent-trace-analytics"

describe("useAgentTraceAnalytics (stub)", () => {
  it("returns a stable null summary regardless of options", () => {
    const { result, rerender } = renderHook<
      ReturnType<typeof useAgentTraceAnalytics>,
      { sessionId?: string }
    >(({ sessionId }) => useAgentTraceAnalytics({ sessionId }), {
      initialProps: { sessionId: undefined } as { sessionId?: string },
    })

    expect(result.current.sessionSummary).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()

    rerender({ sessionId: "abc" })
    expect(result.current.sessionSummary).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it("refresh resolves without throwing", async () => {
    const { result } = renderHook(() => useAgentTraceAnalytics({ sessionId: "x", autoLoad: true }))

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.sessionSummary).toBeNull()
  })

  it("works when called with no options", () => {
    const { result } = renderHook(() => useAgentTraceAnalytics())
    expect(result.current.sessionSummary).toBeNull()
    expect(typeof result.current.refresh).toBe("function")
  })
})
