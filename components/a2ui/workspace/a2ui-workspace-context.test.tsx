/**
 * Tests for A2UIWorkspaceProvider / useWorkspaceContext.
 *
 * The provider holds ephemeral workspace state (selection, mode, zoom, panel
 * visibility). The hook throws when used outside the provider.
 */

import React from "react"
import { renderHook, act } from "@testing-library/react"
import { A2UIWorkspaceProvider, useWorkspaceContext } from "./a2ui-workspace-context"

function wrap(surfaceId = "sx-1") {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <A2UIWorkspaceProvider surfaceId={surfaceId}>{children}</A2UIWorkspaceProvider>
  }
}

describe("A2UIWorkspaceProvider / useWorkspaceContext", () => {
  it("throws when called outside a provider", () => {
    const original = console.error
    console.error = () => {}
    try {
      expect(() => renderHook(() => useWorkspaceContext())).toThrow(/A2UIWorkspaceProvider/)
    } finally {
      console.error = original
    }
  })

  it("seeds sensible defaults", () => {
    const { result } = renderHook(() => useWorkspaceContext(), { wrapper: wrap("sx-1") })
    expect(result.current.surfaceId).toBe("sx-1")
    expect(result.current.selectedComponentId).toBeNull()
    expect(result.current.workspaceMode).toBe("edit")
    expect(result.current.zoom).toBe(100)
    expect(result.current.showTree).toBe(true)
    expect(result.current.showProperties).toBe(true)
  })

  it("updates selectedComponentId via setSelectedComponentId", () => {
    const { result } = renderHook(() => useWorkspaceContext(), { wrapper: wrap() })
    act(() => result.current.setSelectedComponentId("btn"))
    expect(result.current.selectedComponentId).toBe("btn")
    act(() => result.current.setSelectedComponentId(null))
    expect(result.current.selectedComponentId).toBeNull()
  })

  it("cycles workspaceMode between edit / preview / data", () => {
    const { result } = renderHook(() => useWorkspaceContext(), { wrapper: wrap() })
    act(() => result.current.setWorkspaceMode("preview"))
    expect(result.current.workspaceMode).toBe("preview")
    act(() => result.current.setWorkspaceMode("data"))
    expect(result.current.workspaceMode).toBe("data")
    act(() => result.current.setWorkspaceMode("edit"))
    expect(result.current.workspaceMode).toBe("edit")
  })

  it("toggles showTree / showProperties independently", () => {
    const { result } = renderHook(() => useWorkspaceContext(), { wrapper: wrap() })
    act(() => result.current.setShowTree(false))
    expect(result.current.showTree).toBe(false)
    expect(result.current.showProperties).toBe(true)
    act(() => result.current.setShowProperties(false))
    expect(result.current.showProperties).toBe(false)
  })

  it("adjusts zoom level", () => {
    const { result } = renderHook(() => useWorkspaceContext(), { wrapper: wrap() })
    act(() => result.current.setZoom(50))
    expect(result.current.zoom).toBe(50)
  })
})
