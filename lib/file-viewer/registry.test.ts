import { BUILTIN_FILE_VIEWERS, RICH_PREVIEW_EXTENSIONS } from "./builtins"
import {
  __resetFileViewersForTesting,
  getFileViewerRevision,
  listFileViewers,
  registerFileViewer,
  resolveFileViewer,
  subscribeFileViewers,
} from "./registry"
import type { FileViewerContribution } from "./types"

function contribution(overrides: Partial<FileViewerContribution>): FileViewerContribution {
  return {
    id: "test.viewer",
    priority: 50,
    matches: () => true,
    load: async () => ({ default: () => null }),
    ...overrides,
  }
}

describe("file viewer registry", () => {
  afterEach(__resetFileViewersForTesting)

  it("seeds the built-ins at module load, not on first render", () => {
    // `isProjectFilePreviewable` is called during render by four unrelated
    // trees, so the answer cannot depend on a component having mounted.
    expect(listFileViewers().map((entry) => entry.id)).toEqual(
      expect.arrayContaining(BUILTIN_FILE_VIEWERS.map((entry) => entry.id))
    )
  })

  it("refuses a duplicate id", () => {
    const dispose = registerFileViewer(contribution({ id: "dup" }))
    expect(() => registerFileViewer(contribution({ id: "dup" }))).toThrow(/already registered: dup/)
    dispose()
  })

  it("lets a higher priority win a file kind the built-ins already claim", () => {
    expect(resolveFileViewer({ extension: "md", source: "project-preview" })?.id).toBe(
      "builtin.markdown"
    )

    const dispose = registerFileViewer(
      contribution({
        id: "custom.markdown",
        priority: 200,
        matches: (probe) => probe.extension === "md",
      })
    )
    expect(resolveFileViewer({ extension: "md", source: "project-preview" })?.id).toBe(
      "custom.markdown"
    )

    dispose()
    expect(resolveFileViewer({ extension: "md", source: "project-preview" })?.id).toBe(
      "builtin.markdown"
    )
  })

  it("breaks a priority tie by id, not by registration order", () => {
    // Registration order varies with module evaluation order across platforms,
    // so it must not decide which viewer a user sees.
    const disposeZ = registerFileViewer(
      contribution({ id: "z.tie", priority: 10, matches: (p) => p.extension === "tie" })
    )
    const disposeA = registerFileViewer(
      contribution({ id: "a.tie", priority: 10, matches: (p) => p.extension === "tie" })
    )
    expect(resolveFileViewer({ extension: "tie", source: "terminal" })?.id).toBe("a.tie")
    disposeA()
    disposeZ()
  })

  it("returns null when nothing claims the file", () => {
    expect(resolveFileViewer({ extension: "png", source: "project-preview" })).toBeNull()
  })

  it("only removes its own registration when disposed", () => {
    const dispose = registerFileViewer(contribution({ id: "recycled" }))
    dispose()
    const second = registerFileViewer(contribution({ id: "recycled", priority: 90 }))
    // A late disposer from the first registration must not delete the second.
    dispose()
    expect(listFileViewers().some((entry) => entry.id === "recycled")).toBe(true)
    second()
  })

  it("bumps the revision and notifies on register and dispose", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeFileViewers(listener)
    const before = getFileViewerRevision()

    const dispose = registerFileViewer(contribution({ id: "watched" }))
    expect(getFileViewerRevision()).toBeGreaterThan(before)
    expect(listener).toHaveBeenCalledTimes(1)

    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it("restores the built-ins on reset rather than emptying the map", () => {
    registerFileViewer(contribution({ id: "temporary" }))
    __resetFileViewersForTesting()
    expect(listFileViewers().some((entry) => entry.id === "temporary")).toBe(false)
    expect(resolveFileViewer({ extension: "md", source: "project-preview" })?.id).toBe(
      "builtin.markdown"
    )
  })
})

describe("built-in viewers", () => {
  it("claims exactly the extensions the preview capability has always covered", () => {
    for (const extension of RICH_PREVIEW_EXTENSIONS) {
      expect(resolveFileViewer({ extension, source: "project-preview" })).not.toBeNull()
    }
  })

  it("offers the text fallback to terminal links only", () => {
    // Scoping by source is what keeps a Preview tab from appearing on every
    // project file, and avoids a read-only Monaco of the same buffer the
    // editable one beside it is already showing.
    expect(resolveFileViewer({ extension: "py", source: "terminal" })?.id).toBe("builtin.text")
    expect(resolveFileViewer({ extension: "py", source: "project-preview" })).toBeNull()
    expect(resolveFileViewer({ extension: "", source: "terminal" })?.id).toBe("builtin.text")
  })

  it("prefers a rich viewer over the fallback for a terminal link", () => {
    expect(resolveFileViewer({ extension: "md", source: "terminal" })?.id).toBe("builtin.markdown")
  })
})
