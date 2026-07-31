/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { resolveUsageDisplayMode, useUsageDisplayMode } from "./use-usage-display-mode"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async () => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { usageDisplayMode: { mode: "detailed" } } as never,
    save: saveMock as never,
  })
})

describe("resolveUsageDisplayMode", () => {
  it("passes through valid modes", () => {
    expect(resolveUsageDisplayMode("simplified")).toBe("simplified")
    expect(resolveUsageDisplayMode("standard")).toBe("standard")
    expect(resolveUsageDisplayMode("detailed")).toBe("detailed")
  })

  it("defaults invalid/missing values to standard", () => {
    expect(resolveUsageDisplayMode(undefined)).toBe("standard")
    expect(resolveUsageDisplayMode("garbage")).toBe("standard")
    expect(resolveUsageDisplayMode(42)).toBe("standard")
  })
})

describe("useUsageDisplayMode", () => {
  it("reads the stored mode", () => {
    const { result } = renderHook(() => useUsageDisplayMode())
    expect(result.current.mode).toBe("detailed")
  })

  it("falls back to standard when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useUsageDisplayMode())
    expect(result.current.mode).toBe("standard")
  })

  it("persists a new mode via save()", async () => {
    const { result } = renderHook(() => useUsageDisplayMode())
    await act(async () => {
      result.current.setMode("simplified")
    })
    expect(saveMock).toHaveBeenCalledWith({ usageDisplayMode: { mode: "simplified" } })
  })
})
