/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useCanvasFeatureFlag } from "./use-canvas-feature-flag"

const mockIsEnabled = jest.fn()
jest.mock("@/lib/canvas/feature-flags", () => ({
  isCanvasFeatureFlagEnabled: (flag: string) => mockIsEnabled(flag),
}))

describe("useCanvasFeatureFlag", () => {
  beforeEach(() => mockIsEnabled.mockReset())

  it("reconciles to the resolved flag value after mount", () => {
    mockIsEnabled.mockReturnValue(false)
    const { result } = renderHook(() => useCanvasFeatureFlag("canvas.aiWorkbench.v1"))
    expect(mockIsEnabled).toHaveBeenCalledWith("canvas.aiWorkbench.v1")
    expect(result.current).toBe(false)
  })

  it("stays enabled when the flag resolves true", () => {
    mockIsEnabled.mockReturnValue(true)
    const { result } = renderHook(() => useCanvasFeatureFlag("canvas.collaboration.v1"))
    expect(result.current).toBe(true)
  })
})
