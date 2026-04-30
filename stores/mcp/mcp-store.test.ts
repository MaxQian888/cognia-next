import { act, renderHook } from "@testing-library/react"
import { useMcpStore, type McpToolSelectionResult } from "./mcp-store"
import { DEFAULT_TOOL_SELECTION_CONFIG } from "@/types/mcp"
import * as barrel from "./"

it("barrel re-exports useMcpStore", () => {
  expect(barrel.useMcpStore).toBe(useMcpStore)
})

describe("useMcpStore", () => {
  beforeEach(() => {
    // Reset to initial-like state before each test
    useMcpStore.setState({
      servers: [],
      toolSelectionConfig: DEFAULT_TOOL_SELECTION_CONFIG,
      lastToolSelection: null,
    })
  })

  it("starts with empty servers, default tool-selection config, and null lastToolSelection", () => {
    const { result } = renderHook(() => useMcpStore())
    expect(result.current.servers).toEqual([])
    expect(result.current.toolSelectionConfig).toEqual(DEFAULT_TOOL_SELECTION_CONFIG)
    expect(result.current.lastToolSelection).toBeNull()
  })

  it("setToolSelection records the latest result and ignores modeId", () => {
    const result1: McpToolSelectionResult = {
      selectedToolNames: ["read", "write"],
      totalAvailable: 5,
      wasLimited: false,
      fallbackApplied: false,
    }
    const result2: McpToolSelectionResult = {
      selectedToolNames: ["read"],
      totalAvailable: 5,
      wasLimited: true,
      fallbackApplied: true,
    }

    const { result } = renderHook(() => useMcpStore())
    act(() => {
      result.current.setToolSelection("mode-a", result1)
    })
    expect(result.current.lastToolSelection).toEqual(result1)

    // Calling again should overwrite, regardless of modeId
    act(() => {
      result.current.setToolSelection("mode-b", result2)
    })
    expect(result.current.lastToolSelection).toEqual(result2)
  })

  it("setToolSelection accepts an empty result", () => {
    const empty: McpToolSelectionResult = {
      selectedToolNames: [],
      totalAvailable: 0,
      wasLimited: false,
      fallbackApplied: false,
    }
    const { result } = renderHook(() => useMcpStore())
    act(() => {
      result.current.setToolSelection("any", empty)
    })
    expect(result.current.lastToolSelection).toEqual(empty)
  })
})
