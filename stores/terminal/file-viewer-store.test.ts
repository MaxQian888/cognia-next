import { useFileViewerStore } from "./file-viewer-store"

beforeEach(() => {
  useFileViewerStore.setState({ open: false, path: null, line: null, column: null })
})

describe("file-viewer-store", () => {
  it("starts closed", () => {
    const s = useFileViewerStore.getState()
    expect(s.open).toBe(false)
    expect(s.path).toBeNull()
  })

  it("openFile sets path + location and opens", () => {
    useFileViewerStore.getState().openFile("/src/a.ts", 12, 3)
    const s = useFileViewerStore.getState()
    expect(s).toMatchObject({ open: true, path: "/src/a.ts", line: 12, column: 3 })
  })

  it("openFile defaults line/column to null", () => {
    useFileViewerStore.getState().openFile("/src/b.ts")
    const s = useFileViewerStore.getState()
    expect(s).toMatchObject({ open: true, path: "/src/b.ts", line: null, column: null })
  })

  it("close flips open to false but keeps the last path", () => {
    useFileViewerStore.getState().openFile("/src/a.ts", 1, 1)
    useFileViewerStore.getState().close()
    expect(useFileViewerStore.getState().open).toBe(false)
  })
})
