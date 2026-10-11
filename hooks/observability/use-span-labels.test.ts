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

  it("names a span: the tool, or the translated operation with its agent", () => {
    const { result } = renderHook(() => useSpanLabels())
    const { spanName } = result.current
    expect(spanName({ operationName: "invoke_agent", agentName: "Planner" })).toBe(
      "Agent run · Planner"
    )
    expect(spanName({ operationName: "execute_tool", toolName: "read_file" })).toBe("read_file")
    expect(spanName({ operationName: "execute_tool" })).toBe("Tool call")
    expect(spanName({ operationName: "custom_op" })).toBe("custom_op")
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

  it("names the no-model bucket instead of printing the sentinel", () => {
    const label = renderHook(() => useBreakdownLabel("model")).result.current
    expect(label("(unknown)")).toBe("No model")
    expect(label("claude-sonnet-5-5")).toBe("claude-sonnet-5-5")
  })
})
