/**
 * @jest-environment jsdom
 */

const updateSkillMock = jest.fn()
const updateResourceMock = jest.fn()
const getSkillMock = jest.fn()
jest.mock("@/lib/db/skills", () => ({
  getSkill: (...a: unknown[]) => getSkillMock(...a),
  updateSkill: (...a: unknown[]) => updateSkillMock(...a),
}))
jest.mock("@/lib/db/skill-resources", () => ({
  updateResource: (...a: unknown[]) => updateResourceMock(...a),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { useEditorWorkspace } from "./use-editor-workspace"

beforeEach(() => {
  updateSkillMock.mockReset().mockResolvedValue(undefined)
  updateResourceMock.mockReset().mockResolvedValue(undefined)
  getSkillMock.mockReset()
  toastSuccess.mockReset()
  useSkillsStore.setState({
    editorWorkspace: {
      activeSkillId: "s1",
      activeFileId: "main",
      rightPaneOpen: true,
      openFiles: [
        {
          id: "main",
          kind: "main",
          path: "SKILL.md",
          language: "markdown",
          draftContent: "edited",
          savedContent: "orig",
        },
      ],
    },
  } as never)
})

describe("useEditorWorkspace", () => {
  it("saveActive writes draftContent to updateSkill for main", async () => {
    getSkillMock.mockResolvedValue({ id: "s1", name: "Valid Name", content: "orig" })
    const { result } = renderHook(() => useEditorWorkspace())
    await act(async () => {
      await result.current.saveActive()
    })
    expect(updateSkillMock).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ content: "edited" })
    )
  })

  it("saveActive skips main when validation has blocking errors (missing-name)", async () => {
    getSkillMock.mockResolvedValue({ id: "s1", name: "", content: "orig" })
    const { result } = renderHook(() => useEditorWorkspace())
    await act(async () => {
      await result.current.saveActive()
    })
    expect(updateSkillMock).not.toHaveBeenCalled()
  })

  it("saveAll saves main, then resources, then toasts", async () => {
    useSkillsStore.setState((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: [
          {
            id: "main",
            kind: "main" as const,
            path: "SKILL.md",
            language: "markdown" as const,
            draftContent: "main-edit",
            savedContent: "orig",
          },
          {
            id: "r1",
            kind: "resource" as const,
            resourceId: "r1",
            path: "x.sh",
            language: "shell" as const,
            draftContent: "res-edit",
            savedContent: "res",
          },
        ],
      },
    }))
    getSkillMock.mockResolvedValue({ id: "s1", name: "Valid Name", content: "orig" })
    const order: string[] = []
    updateSkillMock.mockImplementation(async () => {
      order.push("skill")
    })
    updateResourceMock.mockImplementation(async () => {
      order.push("resource")
    })
    const { result } = renderHook(() => useEditorWorkspace())
    await act(async () => {
      await result.current.saveAll()
    })
    expect(order).toEqual(["skill", "resource"])
    expect(toastSuccess).toHaveBeenCalledWith("All saved.")
  })

  it("autosave fires for resources without validation gating", async () => {
    jest.useFakeTimers()
    useSkillsStore.setState((s) => ({
      editorWorkspace: {
        ...s.editorWorkspace,
        openFiles: [
          {
            id: "r1",
            kind: "resource" as const,
            resourceId: "r1",
            path: "x.sh",
            language: "shell" as const,
            draftContent: "echo updated",
            savedContent: "echo",
          },
        ],
        activeFileId: "r1",
      },
    }))
    renderHook(() => useEditorWorkspace())
    await act(async () => {
      jest.advanceTimersByTime(2500)
    })
    await waitFor(() => expect(updateResourceMock).toHaveBeenCalled())
    jest.useRealTimers()
  })
})
