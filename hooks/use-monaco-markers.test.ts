import { renderHook, act } from "@testing-library/react"
import {
  useMonacoMarkers,
  type MonacoLike,
  type EditorLike,
  type RawMarker,
} from "./use-monaco-markers"

function makeMonaco(initial: RawMarker[]) {
  let markers = initial
  const listeners: Array<(r: unknown[]) => void> = []
  const monaco: MonacoLike = {
    editor: {
      getModelMarkers: () => markers,
      onDidChangeMarkers: (cb) => {
        listeners.push(cb)
        return { dispose: () => listeners.splice(listeners.indexOf(cb), 1) }
      },
    },
  }
  const setMarkers = (next: RawMarker[]) => {
    markers = next
    act(() => listeners.forEach((l) => l([])))
  }
  return { monaco, setMarkers, listenerCount: () => listeners.length }
}

function makeEditor(uri = "skill:///s/a.ts"): EditorLike & {
  position?: { lineNumber: number; column: number }
  revealed?: number
  focused: boolean
  actions: Record<string, number>
} {
  const ran: Record<string, number> = {}
  return {
    focused: false,
    actions: ran,
    getModel: () => ({ uri: { toString: () => uri } }),
    setPosition(p) {
      this.position = p
    },
    revealLineInCenterIfOutsideViewport(l) {
      this.revealed = l
    },
    focus() {
      this.focused = true
    },
    getAction(id) {
      return {
        run: () => {
          ran[id] = (ran[id] ?? 0) + 1
        },
      }
    },
  }
}

const m = (
  severity: number,
  startLineNumber: number,
  startColumn = 1,
  message = "msg"
): RawMarker => ({
  severity,
  message,
  startLineNumber,
  startColumn,
  endLineNumber: startLineNumber,
  endColumn: startColumn + 1,
})

describe("useMonacoMarkers", () => {
  it("returns empty when monaco or editor is missing", () => {
    const { result } = renderHook(() => useMonacoMarkers(null, null))
    expect(result.current.markers).toEqual([])
    expect(result.current.summary).toEqual({ errors: 0, warnings: 0, infos: 0 })
  })

  it("reads, classifies and sorts markers", () => {
    const { monaco } = makeMonaco([m(4, 5), m(8, 2), m(2, 2, 3), m(1, 1)])
    const editor = makeEditor()
    const { result } = renderHook(() => useMonacoMarkers(monaco, editor))
    expect(result.current.markers.map((x) => x.startLineNumber)).toEqual([1, 2, 2, 5])
    expect(result.current.markers[0].kind).toBe("info") // severity 1 (hint) → info
    expect(result.current.summary).toEqual({ errors: 1, warnings: 1, infos: 2 })
  })

  it("re-reads when markers change", () => {
    const { monaco, setMarkers } = makeMonaco([m(8, 1)])
    const editor = makeEditor()
    const { result } = renderHook(() => useMonacoMarkers(monaco, editor))
    expect(result.current.summary.errors).toBe(1)
    setMarkers([])
    expect(result.current.markers).toEqual([])
    expect(result.current.summary).toEqual({ errors: 0, warnings: 0, infos: 0 })
  })

  it("disposes its subscription on unmount", () => {
    const { monaco, listenerCount } = makeMonaco([])
    const editor = makeEditor()
    const { unmount } = renderHook(() => useMonacoMarkers(monaco, editor))
    expect(listenerCount()).toBe(1)
    unmount()
    expect(listenerCount()).toBe(0)
  })

  it("empties markers when the editor has no model", () => {
    const { monaco } = makeMonaco([m(8, 1)])
    const editor = makeEditor()
    editor.getModel = () => null
    const { result } = renderHook(() => useMonacoMarkers(monaco, editor))
    expect(result.current.markers).toEqual([])
  })

  it("jumpTo moves the caret, reveals and focuses", () => {
    const { monaco } = makeMonaco([m(8, 7, 3)])
    const editor = makeEditor()
    const { result } = renderHook(() => useMonacoMarkers(monaco, editor))
    act(() => result.current.jumpTo(result.current.markers[0]))
    expect(editor.position).toEqual({ lineNumber: 7, column: 3 })
    expect(editor.revealed).toBe(7)
    expect(editor.focused).toBe(true)
  })

  it("next/previous run the Monaco marker-navigation actions", () => {
    const { monaco } = makeMonaco([m(8, 1)])
    const editor = makeEditor()
    const { result } = renderHook(() => useMonacoMarkers(monaco, editor))
    act(() => result.current.next())
    act(() => result.current.previous())
    expect(editor.actions["editor.action.marker.next"]).toBe(1)
    expect(editor.actions["editor.action.marker.prev"]).toBe(1)
  })

  it("jumpTo/next/previous are no-ops without an editor", () => {
    const { result } = renderHook(() => useMonacoMarkers(null, null))
    expect(() =>
      act(() => {
        result.current.jumpTo({
          severity: 8,
          kind: "error",
          message: "x",
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        })
        result.current.next()
        result.current.previous()
      })
    ).not.toThrow()
  })
})
