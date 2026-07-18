import { renderHook } from "@testing-library/react"
import { useContextWorkbenchSurfaceFlag } from "./use-context-workbench-surface-flag"

jest.mock("@/lib/context-workbench/feature-flags", () => ({
  isContextWorkbenchSurfaceEnabled: (surface: string) => surface === "project",
}))

describe("useContextWorkbenchSurfaceFlag", () => {
  it("reads the requested surface", () => {
    expect(renderHook(() => useContextWorkbenchSurfaceFlag("project")).result.current).toBe(true)
    expect(renderHook(() => useContextWorkbenchSurfaceFlag("canvas")).result.current).toBe(false)
  })
})
