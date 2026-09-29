/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { Project } from "@/types"

// next-intl is globally mocked against en.json in jest.setup.ts.

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))
jest.mock("@/lib/project-coordinator/pause", () => ({
  pauseProject: jest.fn(async () => undefined),
  resumeProject: jest.fn(async () => undefined),
}))

import { useProjectStore } from "@/stores/project/project-store"
import { pauseProject, resumeProject } from "@/lib/project-coordinator/pause"
import { useProjectPause } from "./use-project-pause"

beforeEach(() => {
  jest.clearAllMocks()
  useProjectStore.setState({
    projects: [{ id: "p1", coordinator: { enabled: true, paused: { at: 7 } } } as Project],
  })
})

describe("useProjectPause", () => {
  it("reads the recorded pause", () => {
    const { result } = renderHook(() => useProjectPause("p1"))
    expect(result.current.paused).toEqual({ at: 7 })
    expect(result.current.enabled).toBe(true)
    expect(result.current.busy).toBe(false)
  })

  it("pauses with a reason and resumes", async () => {
    const { result } = renderHook(() => useProjectPause("p1"))
    await act(() => result.current.pause("lunch"))
    expect(pauseProject).toHaveBeenCalledWith("p1", { reason: "lunch" })
    await act(() => result.current.resume())
    expect(resumeProject).toHaveBeenCalledWith("p1")
  })

  it("reports a failure instead of throwing", async () => {
    ;(resumeProject as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useProjectPause("p1"))
    await act(() => result.current.resume())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("boom"))
    expect(result.current.busy).toBe(false)
  })
})
