/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

let flag = true
let gate = { known: false, decision: null, canStart: true, canMutate: true, canRead: true }
jest.mock("./use-canvas-feature-flag", () => ({ useCanvasFeatureFlag: () => flag }))
const useCollabFeature = jest.fn(() => gate)
jest.mock("@/hooks/collab/use-collab-feature", () => ({
  useCollabFeature: (...args: unknown[]) => useCollabFeature(...(args as [])),
}))

import { useCanvasCollaborationEnabled } from "./use-canvas-collaboration-enabled"

describe("useCanvasCollaborationEnabled", () => {
  beforeEach(() => {
    flag = true
    gate = { known: false, decision: null, canStart: true, canMutate: true, canRead: true }
  })

  it("follows the local flag while the server has not decided", () => {
    expect(renderHook(() => useCanvasCollaborationEnabled()).result.current).toBe(true)
    flag = false
    expect(renderHook(() => useCanvasCollaborationEnabled()).result.current).toBe(false)
  })

  it("asks about the org-scoped canvas feature", () => {
    renderHook(() => useCanvasCollaborationEnabled())
    expect(useCollabFeature).toHaveBeenCalledWith("canvas-collaboration", null)
  })

  it("lets the server close what the flag opens, never the reverse", () => {
    gate = { ...gate, known: true, canMutate: false }
    expect(renderHook(() => useCanvasCollaborationEnabled()).result.current).toBe(false)
    flag = false
    gate = { ...gate, canMutate: true }
    expect(renderHook(() => useCanvasCollaborationEnabled()).result.current).toBe(false)
  })
})
