/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useArtifactList } from "./use-artifact-list"
import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
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
    panelOpen: false,
    panelView: "artifact",
  })
  useChatStore.setState({ activeSessionId: "s1" })
})

describe("useArtifactList", () => {
  it("returns the active session's artifacts", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { result } = renderHook(() => useArtifactList({}))
    expect(result.current.sessionArtifacts).toHaveLength(1)
  })

  it("setSearchQuery / setTypeFilter / setRuntimeFilter update the workspace", () => {
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    act(() => result.current.setSearchQuery("alpha"))
    expect(useArtifactStore.getState().artifactWorkspace.searchQuery).toBe("alpha")
    act(() => result.current.setTypeFilter("html"))
    expect(useArtifactStore.getState().artifactWorkspace.typeFilter).toBe("html")
    act(() => result.current.setRuntimeFilter("error"))
    expect(useArtifactStore.getState().artifactWorkspace.runtimeFilter).toBe("error")
  })

  it("toggleBatchMode flips batchMode and clears selection", () => {
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    expect(result.current.batchMode).toBe(false)
    act(() => result.current.toggleBatchMode())
    expect(result.current.batchMode).toBe(true)
  })

  it("handleArtifactClick reveals the artifact and runs the callback", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const onClick = jest.fn()
    const { result } = renderHook(() =>
      useArtifactList({ sessionId: "s1", onArtifactClick: onClick })
    )
    act(() => result.current.handleArtifactClick(a))
    expect(onClick).toHaveBeenCalledWith(a)
    expect(selectActiveArtifactId(useArtifactStore.getState(), "s1")).toBe(a.id)
  })

  it("handleArtifactClick toggles selection in batch mode", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    act(() => result.current.toggleBatchMode())
    act(() => result.current.handleArtifactClick(a))
    expect(result.current.selectedIds.has(a.id)).toBe(true)
    act(() => result.current.handleArtifactClick(a))
    expect(result.current.selectedIds.has(a.id)).toBe(false)
  })

  it("handleDelete arms a single delete", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    const fakeEvent = { stopPropagation: jest.fn() } as unknown as React.MouseEvent
    act(() => result.current.handleDelete(a.id, fakeEvent))
    expect(result.current.pendingDelete).toBe(a.id)
    expect(fakeEvent.stopPropagation).toHaveBeenCalled()
  })

  it("handleBatchDelete arms a batch delete with the selected ids", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    act(() => result.current.toggleBatchMode())
    act(() => result.current.handleArtifactClick(a))
    act(() => result.current.handleBatchDelete())
    expect(Array.isArray(result.current.pendingDelete)).toBe(true)
  })

  it("confirmDelete removes a single artifact", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "Foo",
      content: "x",
    })
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    act(() =>
      result.current.handleDelete(a.id, {
        stopPropagation: jest.fn(),
      } as unknown as React.MouseEvent)
    )
    act(() => result.current.confirmDelete())
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
  })

  it("confirmDelete is a no-op when nothing is pending", () => {
    const { result } = renderHook(() => useArtifactList({ sessionId: "s1" }))
    act(() => result.current.confirmDelete())
    expect(result.current.pendingDelete).toBeNull()
  })
})
