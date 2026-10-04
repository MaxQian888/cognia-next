/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useBreakdownLabel, useSpanLabels } from "./use-span-labels"

// The global next-intl mock resolves keys against the real en bundle and
// implements `t.has`, which is exactly the contract the hook relies on.

describe("useSpanLabels", () => {
  it("translates known operation, surface and span-kind ids", () => {
    const { result } = renderHook(() => useSpanLabels())
    expect(result.current.operation("execute_tool")).toBe("Tool call")
    expect(result.current.surface("agent-team")).toBe("Agent team")
    expect(result.current.spanKind("client")).toBe("Client")
    expect(result.current.label("operation", "invoke_agent")).toBe("Agent run")
  })

  it("falls back to the raw id for values the build does not know", () => {
    const { result } = renderHook(() => useSpanLabels())
    expect(result.current.surface("custom-surface")).toBe("custom-surface")
    expect(result.current.operation("")).toBe("")
  })

  it("never lets a dotted id be read as a message path", () => {
    const { result } = renderHook(() => useSpanLabels())
    expect(result.current.surface("operation.chat")).toBe("operation.chat")
  })
})

describe("useBreakdownLabel", () => {
  it("translates the enum-backed dimensions only", () => {
    expect(renderHook(() => useBreakdownLabel("operation")).result.current("chat")).toBe(
      "Model call"
    )
    expect(renderHook(() => useBreakdownLabel("surface")).result.current("mcp")).toBe("MCP")
    expect(renderHook(() => useBreakdownLabel("model")).result.current("chat")).toBe("chat")
    expect(renderHook(() => useBreakdownLabel(undefined)).result.current("x")).toBe("x")
  })
})
