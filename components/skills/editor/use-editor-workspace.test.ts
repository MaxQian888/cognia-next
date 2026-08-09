/** @jest-environment jsdom */

const saveWorkspaceMock = jest.fn()
jest.mock("@/lib/db/skill-workspace", () => ({
  saveSkillWorkspace: (...args: unknown[]) => saveWorkspaceMock(...args),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { useEditorWorkspace } from "./use-editor-workspace"

beforeEach(() => {
  saveWorkspaceMock.mockReset().mockResolvedValue({ status: "saved", savedFileIds: ["main"] })
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
          saveState: "clean",
        },
      ],
    },
  } as never)
})

describe("useEditorWorkspace", () => {
  it("saveActive returns an explicit result and advances the saved baseline", async () => {
    const { result } = renderHook(() => useEditorWorkspace())
    let outcome: Awaited<ReturnType<typeof result.current.saveActive>> | undefined
    await act(async () => {
      outcome = await result.current.saveActive()
    })
    expect(outcome?.status).toBe("saved")
    expect(saveWorkspaceMock).toHaveBeenCalledWith({
      skillId: "s1",
      files: [expect.objectContaining({ id: "main", baseline: "orig", content: "edited" })],
    })
    expect(useSkillsStore.getState().editorWorkspace.openFiles[0]).toEqual(
      expect.objectContaining({ savedContent: "edited", saveState: "saved" })
    )
  })

  it("keeps drafts dirty and exposes conflict state", async () => {
    saveWorkspaceMock.mockResolvedValue({
      status: "conflict",
      fileIds: ["main"],
      message: "changed elsewhere",
    })
    const { result } = renderHook(() => useEditorWorkspace())
    await act(async () => {
      await result.current.saveActive()
    })
    expect(useSkillsStore.getState().editorWorkspace.openFiles[0]).toEqual(
      expect.objectContaining({
        draftContent: "edited",
        savedContent: "orig",
        saveState: "conflict",
        saveError: "changed elsewhere",
      })
    )
  })

  it("Save All submits every dirty file once and signals only after commit", async () => {
    useSkillsStore.setState((state) => ({
      editorWorkspace: {
        ...state.editorWorkspace,
        openFiles: [
          ...state.editorWorkspace.openFiles,
          {
            id: "r1",
            kind: "resource" as const,
            resourceId: "r1",
            path: "scripts/x.sh",
            language: "shell" as const,
            draftContent: "new resource",
            savedContent: "old resource",
          },
        ],
      },
    }))
    saveWorkspaceMock.mockResolvedValue({ status: "saved", savedFileIds: ["main", "r1"] })
    const { result } = renderHook(() => useEditorWorkspace())
    const before = result.current.savedAllSignal
    await act(async () => {
      await result.current.saveAll()
    })
    expect(saveWorkspaceMock).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceMock.mock.calls[0][0].files).toHaveLength(2)
    expect(result.current.savedAllSignal).toBe(before + 1)
  })

  it("does not signal Save All when the transaction is refused", async () => {
    saveWorkspaceMock.mockResolvedValue({ status: "blocked", fileIds: ["main"], message: "empty" })
    const { result } = renderHook(() => useEditorWorkspace())
    const before = result.current.savedAllSignal
    await act(async () => {
      await result.current.saveAll()
    })
    expect(result.current.savedAllSignal).toBe(before)
  })

  it("autosave failures preserve the draft and can be retried by editing", async () => {
    jest.useFakeTimers()
    saveWorkspaceMock.mockResolvedValue({ status: "error", fileIds: ["main"], message: "disk" })
    renderHook(() => useEditorWorkspace())
    await act(async () => {
      jest.advanceTimersByTime(2500)
    })
    await waitFor(() => expect(saveWorkspaceMock).toHaveBeenCalled())
    expect(useSkillsStore.getState().editorWorkspace.openFiles[0].saveState).toBe("error")
    act(() => useSkillsStore.getState().updateDraftContent("main", "edited again"))
    expect(useSkillsStore.getState().editorWorkspace.openFiles[0]).toEqual(
      expect.objectContaining({ saveState: "clean", saveError: undefined })
    )
    jest.useRealTimers()
  })
})
