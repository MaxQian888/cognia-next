/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn(),
  openPath: jest.fn(),
}))

import { useArtifactPanelState } from "./use-artifact-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactId: null,
    artifactVersions: {},
    pendingReviews: {},
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
    panelOpen: false,
    panelView: "artifact",
  })
})

function makeArtifact() {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type: "html",
    title: "Page",
    content: "<!DOCTYPE html><html><body></body></html>",
    language: "html",
  })
}

describe("useArtifactPanelState", () => {
  it("derives isPreviewable / panelMode for an HTML artifact", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isPreviewable).toBe(true)
    expect(result.current.primaryActions).toContain("modeTabs")
    expect(result.current.primaryActions).toContain("close")
  })

  it("does not include modeTabs for non-previewable types", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "T",
      content: "x",
      language: "javascript",
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.primaryActions).not.toContain("modeTabs")
  })

  it("handleEditMode flips viewMode to edit", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    expect(result.current.viewMode).toBe("edit")
  })

  it("handleSaveEdit persists changes and exits edit mode", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleEditorChange("<html>changed</html>"))
    act(() => result.current.handleSaveEdit())
    expect(result.current.viewMode).toBe("code")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<html>changed</html>")
  })

  it("handleCancelEdit drops changes", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleCancelEdit())
    expect(result.current.viewMode).toBe("code")
    expect(result.current.hasChanges).toBe(false)
  })

  it("toggleFullscreen flips isFullscreen", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.toggleFullscreen())
    expect(result.current.isFullscreen).toBe(true)
  })

  it("handleCopy writes to navigator.clipboard", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleCopy()
    })
    expect(writeText).toHaveBeenCalledWith(a.content)
  })

  it("handleOpenInCanvas creates a canvas document", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleOpenInCanvas())
    expect(Object.keys(useArtifactStore.getState().canvasDocuments).length).toBeGreaterThan(0)
  })

  it("auto-enters review mode when a pending proposal appears and exposes it", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("code")
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("review")
    expect(result.current.pendingReview).not.toBeNull()
  })

  it("leaves review mode for code once the proposal is resolved", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("review")
    act(() => useArtifactStore.getState().rejectArtifactReview(a.id))
    expect(result.current.viewMode).toBe("code")
    expect(result.current.pendingReview).toBeNull()
  })

  it("does not yank the user out of edit mode when a proposal appears", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    expect(result.current.viewMode).toBe("edit")
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("edit")
  })

  it("handleDownload triggers a blob download", () => {
    // jsdom omits URL.createObjectURL/revokeObjectURL.
    const createObjectURL = jest.fn(() => "blob:mock")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const a = makeArtifact()
    const created: HTMLAnchorElement[] = []
    const orig = document.createElement.bind(document)
    const spy = jest.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag) as HTMLElement
      if (tag === "a") created.push(el as HTMLAnchorElement)
      return el
    })
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleDownload())
    expect(created.some((el) => el.download.startsWith(a.title))).toBe(true)
    expect(createObjectURL).toHaveBeenCalled()
    spy.mockRestore()
  })
})
