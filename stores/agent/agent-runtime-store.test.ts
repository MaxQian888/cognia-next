/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { useAgentRuntimeStore } from "./agent-runtime-store"
// Touch the outer agent barrel so its `export *` lines are covered.
import * as outerAgentBarrel from "./"

it("outer agent barrel re-exports useAgentRuntimeStore", () => {
  expect(outerAgentBarrel.useAgentRuntimeStore).toBe(useAgentRuntimeStore)
})

describe("useAgentRuntimeStore", () => {
  beforeEach(() => {
    // Reset to documented defaults before each test
    useAgentRuntimeStore.setState({
      runtime: "claude-sdk",
      modeId: "general",
      externalAgentId: null,
    })
  })

  it("has the documented defaults", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())
    expect(result.current.runtime).toBe("claude-sdk")
    expect(result.current.modeId).toBe("general")
    expect(result.current.externalAgentId).toBeNull()
  })

  it("setRuntime switches between claude-sdk and external", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setRuntime("external"))
    expect(result.current.runtime).toBe("external")

    act(() => result.current.setRuntime("claude-sdk"))
    expect(result.current.runtime).toBe("claude-sdk")
  })

  it("setModeId updates the active mode id", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setModeId("research"))
    expect(result.current.modeId).toBe("research")
  })

  it("setExternalAgentId accepts a string and null (clear)", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setExternalAgentId("agent-42"))
    expect(result.current.externalAgentId).toBe("agent-42")

    act(() => result.current.setExternalAgentId(null))
    expect(result.current.externalAgentId).toBeNull()
  })

  it("persists under the documented localStorage key", () => {
    // Trigger a state change to flush the persist middleware
    act(() => useAgentRuntimeStore.getState().setModeId("persisted-mode"))

    // The persist middleware writes synchronously to localStorage on set.
    const stored = window.localStorage.getItem("cognia-next.agent-runtime")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.modeId).toBe("persisted-mode")
    expect(parsed.version).toBe(1)
  })
})
