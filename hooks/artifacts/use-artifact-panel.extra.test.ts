/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const revealInExplorer = jest.fn().mockResolvedValue(undefined)
const openPath = jest.fn().mockResolvedValue(undefined)
const saveExport = jest.fn().mockResolvedValue({ kind: "saved", location: "Page.html" })

// `stores/index.ts` calls `isTauri()` at module top-level inside a Zustand
// `create()`; that fires during ES import hoisting, before any `let` in this
// file initialises. Owning the toggle ref inside the factory dodges the TDZ.
jest.mock("@/lib/tauri", () => {
  const ref = { value: true }
  return {
    isTauri: () => ref.value,
    __setIsTauri: (next: boolean) => {
      ref.value = next
    },
  }
})
const { __setIsTauri } = jest.requireMock("@/lib/tauri") as {
  __setIsTauri: (next: boolean) => void
}
function setIsTauriValue(next: boolean) {
  __setIsTauri(next)
}

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: (...args: unknown[]) => revealInExplorer(...args),
  openPath: (...args: unknown[]) => openPath(...args),
}))

jest.mock("@/lib/files/save-export", () => ({
  saveExport: (...args: unknown[]) => saveExport(...args),
}))

jest.mock("@tauri-apps/api/path", () => ({
  downloadDir: jest.fn().mockResolvedValue("/Users/me/Downloads/"),
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => true,
}))

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async (id: string) => ({ id, projectId: "p1" })),
}))

import { useArtifactPanelState } from "./use-artifact-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { loggers } from "@cognia/logging"

/** A chat bound to a project rooted at /repo, the shape saveToProject needs. */
function bindSessionToProject() {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "Repo", roots: [{ id: "r1", path: "/repo", isPrimary: true }] }],
  } as never)
  useChatStore.setState({ activeSessionId: "s" } as never)
}

beforeEach(() => {
  localStorage.clear()
  revealInExplorer.mockClear()
  openPath.mockClear()
  saveExport.mockClear().mockResolvedValue({ kind: "saved", location: "Page.html" })
  setIsTauriValue(true)
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactId: null,
    artifactVersions: {},
    artifactWorkspace: {
      scope: "session",
      sessionId: null,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
    canvasDocuments: {},
    activeCanvasId: null,
    canvasOpen: false,
    analysisResults: {},
    panelOpen: true,
    panelView: "artifact",
  })
})

function makeArtifact() {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type: "html",
    title: "Page",
    content: "<!DOCTYPE html><html></html>",
    language: "html",
  })
}

describe("saveToProject", () => {
  beforeEach(() => {
    bindSessionToProject()
    act(() => useArtifactDockLayoutStore.getState().resetLayout())
  })

  it("offers the action only where there is a filesystem to write to", () => {
    makeArtifact()
    const { result, rerender } = renderHook(() => useArtifactPanelState())
    expect(result.current.overflowActions).toContain("saveToProject")

    setIsTauriValue(false)
    rerender()
    expect(result.current.overflowActions).not.toContain("saveToProject")
  })

  it("opens the save dialog in the session's project root", async () => {
    const a = makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/src/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // Without this the dialog lands wherever the user saved last, which is
    // rarely the project they are working in.
    expect(saveExport).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDirectory: "/repo", filename: `${a.title}.html` })
    )
  })

  it("reveals a file saved inside the project in the workspace panel", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/src/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // The point of the action: land in the workspace with the diff one tab away.
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toMatchObject({
      kind: "file",
      rootPath: "/repo",
      relPath: "src/Page.html",
    })
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("falls back to the OS file manager when the user saves outside the project", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/elsewhere/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).toHaveBeenCalledWith("/elsewhere/Page.html")
  })

  it("does nothing when the save dialog is cancelled", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "cancelled" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("does nothing without an active artifact", async () => {
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(saveExport).not.toHaveBeenCalled()
  })

  it("falls back to the artifact's own project when the chat is unbound", async () => {
    useChatStore.setState({ activeSessionId: null } as never)
    const a = makeArtifact()
    act(() =>
      useArtifactStore.setState((state) => ({
        artifacts: { ...state.artifacts, [a.id]: { ...state.artifacts[a.id], projectId: "p1" } },
      }))
    )
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(saveExport).toHaveBeenCalledWith(expect.objectContaining({ defaultDirectory: "/repo" }))
    // No session id means nothing to scope a workspace reveal to.
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).toHaveBeenCalledWith("/repo/Page.html")
  })

  it("still saves when neither the chat nor the artifact names a project", async () => {
    useProjectStore.setState({ projects: [] } as never)
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/anywhere/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // A rootless workspace still gets a save dialog — it just opens wherever
    // the OS last left it, and the result is revealed in the file manager.
    expect(saveExport).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDirectory: undefined })
    )
    expect(revealInExplorer).toHaveBeenCalledWith("/anywhere/Page.html")
  })

  it("surfaces a write failure instead of reporting success", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "error", message: "disk full" })
    const { result } = renderHook(() => useArtifactPanelState())

    await expect(result.current.handleSaveToProject()).rejects.toThrow("disk full")
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
  })
})

describe("useArtifactPanelState — extra coverage", () => {
  it("Esc keyboard shortcut closes the panel", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(useArtifactStore.getState().panelOpen).toBe(false)
    // result.current is still readable after the unmount-side cleanup ran.
    expect(typeof result.current).toBe("object")
  })

  it("Ctrl+E enters edit mode for a previewable artifact", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true }))
    })
    expect(result.current.viewMode).toBe("edit")
  })

  it("Ctrl+S in edit mode persists pending changes", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleEditorChange("<html>changed</html>"))
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
    })
    expect(result.current.viewMode).toBe("code")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<html>changed</html>")
  })

  it("keyboard shortcuts ignore events from input/textarea", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    const input = document.createElement("input")
    document.body.appendChild(input)
    act(() => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    // panelOpen stays true because the handler bailed out.
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(result.current.viewMode).toBe("code")
  })

  it("handleRevealInExplorer is a no-op when not desktop", async () => {
    setIsTauriValue(false)
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleRevealInExplorer()
    })
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("handleRevealInExplorer falls back to openPath when reveal throws and logs the failure", async () => {
    const warnSpy = jest.spyOn(loggers.ui, "warn").mockImplementation()
    revealInExplorer.mockRejectedValueOnce(new Error("boom"))
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    // Mark a download path so the action arms.
    Object.assign(URL, {
      createObjectURL: jest.fn(() => "blob:x"),
      revokeObjectURL: jest.fn(),
    })
    await act(async () => {
      await result.current.handleDownload()
    })
    await act(async () => {
      await result.current.handleRevealInExplorer()
    })
    expect(revealInExplorer).toHaveBeenCalled()
    expect(openPath).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.reveal.failed",
      expect.objectContaining({ artifactId: expect.any(String) })
    )
    warnSpy.mockRestore()
    void a
  })

  it("marks html/svg as openable in a new tab and exposes the overflow action", () => {
    makeArtifact() // html
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isOpenableInNewTab).toBe(true)
    expect(result.current.overflowActions).toContain("openInNewTab")
  })

  it("handleOpenInNewTab opens a blob URL and revokes it after a grace period", () => {
    jest.useFakeTimers()
    makeArtifact()
    const createObjectURL = jest.fn(() => "blob:mock")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleOpenInNewTab())
    expect(createObjectURL).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("blob:mock", "_blank", "noopener,noreferrer")
    act(() => jest.advanceTimersByTime(10001))
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock")
    jest.useRealTimers()
  })

  it("code artifacts are not openable in a new tab", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Snippet",
      content: "x=1",
      language: "python",
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isOpenableInNewTab).toBe(false)
    expect(result.current.overflowActions).not.toContain("openInNewTab")
  })

  it("setViewMode accepts the split mode", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.setViewMode("split"))
    expect(result.current.viewMode).toBe("split")
  })

  it("buildReturnContext is exposed via handleOpenInCanvas with no active artifact", () => {
    // Without an active artifact, handleOpenInCanvas is a no-op.
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.activeArtifact).toBeNull()
    act(() => result.current.handleOpenInCanvas())
    expect(Object.keys(useArtifactStore.getState().canvasDocuments)).toHaveLength(0)
  })

  describe("handleOpenInCanvas document reuse", () => {
    function openArtifactInCanvas() {
      const artifact = useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "html",
        title: "page",
        content: "<p>hi</p>",
      })
      act(() => useArtifactStore.getState().setActiveArtifact(artifact.id))
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleOpenInCanvas())
      return { artifact, result }
    }

    it("links the artifact to the document it created", () => {
      const { artifact } = openArtifactInCanvas()

      const docId = useArtifactStore.getState().activeCanvasId
      expect(docId).toBeTruthy()
      // Both directions of the lineage, so either side can find the other.
      expect(useArtifactStore.getState().canvasDocuments[docId!]?.sourceArtifactId).toBe(
        artifact.id
      )
      expect(
        useArtifactStore.getState().artifacts[artifact.id]?.metadata?.derivedFromCanvasDocumentId
      ).toBe(docId)
    })

    it("reopens the same document instead of minting duplicates", () => {
      // Alternating between the panel and the canvas used to leave a trail of
      // copies, with the user's edits stranded in whichever one they left.
      const { result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId

      act(() => useArtifactStore.getState().closeCanvas())
      act(() => result.current.handleOpenInCanvas())

      expect(useArtifactStore.getState().activeCanvasId).toBe(firstDocId)
      expect(Object.keys(useArtifactStore.getState().canvasDocuments)).toHaveLength(1)
      expect(useArtifactStore.getState().canvasOpen).toBe(true)
    })

    it("creates a fresh document when the linked one was deleted", () => {
      const { result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId!

      act(() => useArtifactStore.getState().deleteCanvasDocument(firstDocId))
      act(() => result.current.handleOpenInCanvas())

      const nextDocId = useArtifactStore.getState().activeCanvasId
      expect(nextDocId).toBeTruthy()
      expect(nextDocId).not.toBe(firstDocId)
    })
  })
})
