/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

import { useAgentConnectionStatus } from "./use-agent-connection-status"

describe("useAgentConnectionStatus", () => {
  beforeEach(() => {
    act(() => useExternalAgentStore.setState({ connectionStatus: {} }))
  })

  it("answers disconnected for an agent nothing has connected", () => {
    const { result } = renderHook(() => useAgentConnectionStatus("pi-1"))
    expect(result.current).toBe("disconnected")
  })

  it("uses the caller's fallback only while the map has never heard of the agent", () => {
    // A caller holding a runtime instance knows more than an empty map does.
    const { result, rerender } = renderHook(() => useAgentConnectionStatus("pi-1", "connected"))
    expect(result.current).toBe("connected")
    act(() => useExternalAgentStore.setState({ connectionStatus: { "pi-1": "error" } }))
    rerender()
    // Once the map has an answer the fallback stops applying, so the two can
    // never disagree.
    expect(result.current).toBe("error")
  })

  it("follows the shared map, which is what the lifecycle listener writes", () => {
    const { result } = renderHook(() => useAgentConnectionStatus("pi-1"))
    act(() => useExternalAgentStore.setState({ connectionStatus: { "pi-1": "connected" } }))
    expect(result.current).toBe("connected")
  })

  it("does not re-render for a different agent's transition", () => {
    // Every surface subscribes one of these per row, so a panel with several
    // agents must not repaint all of them when one connects.
    let renders = 0
    renderHook(() => {
      renders += 1
      return useAgentConnectionStatus("pi-1")
    })
    const before = renders
    act(() => useExternalAgentStore.setState({ connectionStatus: { other: "connected" } }))
    expect(renders).toBe(before)
  })
})
