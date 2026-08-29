/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import { act } from "react"
import { useCanvasDocumentSummaries } from "./use-canvas-document-summaries"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

beforeEach(() => {
  useArtifactStore.setState({ canvasDocuments: {}, activeCanvasId: null })
})

function seed(title: string, content = "x") {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      title,
      content,
      language: "markdown",
      type: "text",
    })
  })
  return id
}

describe("useCanvasDocumentSummaries", () => {
  it("returns identity + label fields and no content", () => {
    seed("Alpha")
    const { result } = renderHook(() => useCanvasDocumentSummaries())
    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({ title: "Alpha", language: "markdown", type: "text" })
    expect(result.current[0]).not.toHaveProperty("content")
  })

  it("keeps an unchanged document's summary referentially stable", () => {
    // This is the whole point: editing one document must not invalidate the
    // rail entries for all the others.
    const keep = seed("Keep")
    const edit = seed("Edit")
    const { result } = renderHook(() => useCanvasDocumentSummaries())
    const before = result.current.find((d) => d.id === keep)

    act(() => {
      useArtifactStore.getState().updateCanvasDocument(edit, { content: "changed" })
    })

    expect(result.current.find((d) => d.id === keep)).toBe(before)
  })

  it("does not re-render for a store change that touches no document", () => {
    // Subscribing to `s.canvasDocuments` re-rendered on every artifact-store
    // write, including ones with nothing to do with canvas.
    seed("Only")
    let renders = 0
    renderHook(() => {
      renders += 1
      return useCanvasDocumentSummaries()
    })
    const initial = renders

    act(() => {
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: "unrelated",
        content: "x",
      })
    })

    expect(renders).toBe(initial)
  })

  it("re-renders once per commit, not once per keystroke", () => {
    // `updatedAt` is on the summary because the rail sorts and labels by it, so
    // a landed commit legitimately changes one row. What this buys is that the
    // OTHER rows keep identity — and, with the panel's debounce, a commit is
    // one per typing pause rather than one per character.
    const id = seed("Only")
    let renders = 0
    renderHook(() => {
      renders += 1
      return useCanvasDocumentSummaries()
    })
    const initial = renders

    act(() => {
      useArtifactStore.getState().updateCanvasDocument(id, { content: "a" })
    })
    act(() => {
      useArtifactStore.getState().updateCanvasDocument(id, { content: "ab" })
    })

    expect(renders).toBe(initial + 2)
  })

  it("re-renders when a label the list actually shows changes", () => {
    const id = seed("Before")
    const { result } = renderHook(() => useCanvasDocumentSummaries())
    act(() => {
      useArtifactStore.getState().updateCanvasDocument(id, { title: "After" })
    })
    expect(result.current[0].title).toBe("After")
  })

  it("drops a removed document, and its cache entry with it", () => {
    const a = seed("A")
    seed("B")
    const { result } = renderHook(() => useCanvasDocumentSummaries())
    expect(result.current).toHaveLength(2)
    act(() => {
      useArtifactStore.getState().deleteCanvasDocument(a)
    })
    expect(result.current.map((d) => d.title)).toEqual(["B"])
  })
})
