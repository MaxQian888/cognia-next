/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { resolveAgentFlowMode, useAgentFlowMode } from "./use-agent-flow-mode"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async () => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { agentFlowMode: { mode: "detailed" } } as never,
    save: saveMock as never,
  })
})

describe("resolveAgentFlowMode", () => {
  it("passes through valid modes", () => {
    expect(resolveAgentFlowMode("simplified")).toBe("simplified")
    expect(resolveAgentFlowMode("standard")).toBe("standard")
    expect(resolveAgentFlowMode("detailed")).toBe("detailed")
  })

  it("defaults invalid/missing values to standard", () => {
    expect(resolveAgentFlowMode(undefined)).toBe("standard")
    expect(resolveAgentFlowMode("garbage")).toBe("standard")
    expect(resolveAgentFlowMode(42)).toBe("standard")
  })
})

describe("useAgentFlowMode", () => {
  it("reads the stored mode", () => {
    const { result } = renderHook(() => useAgentFlowMode())
    expect(result.current.mode).toBe("detailed")
  })

  it("falls back to standard when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useAgentFlowMode())
    expect(result.current.mode).toBe("standard")
  })

  it("persists a new mode via save()", async () => {
    const { result } = renderHook(() => useAgentFlowMode())
    await act(async () => {
      result.current.setMode("simplified")
    })
    expect(saveMock).toHaveBeenCalledWith({ agentFlowMode: { mode: "simplified" } })
  })
})
