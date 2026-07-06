/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const revealInExplorer = jest.fn().mockResolvedValue(undefined)
const openPath = jest.fn().mockResolvedValue(undefined)

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

jest.mock("@tauri-apps/api/path", () => ({
  downloadDir: jest.fn().mockResolvedValue("/Users/me/Downloads/"),
}))

import { useArtifactPanelState } from "./use-artifact-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { loggers } from "@/lib/logging"

beforeEach(() => {
  localStorage.clear()
  revealInExplorer.mockClear()
  openPath.mockClear()
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
    act(() => result.current.handleDownload())
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
})
