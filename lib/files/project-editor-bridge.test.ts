import {
  registerProjectEditorOpener,
  openInProjectEditor,
  deferProjectEditorOpen,
  __resetProjectEditorBridgeForTesting,
} from "./project-editor-bridge"

beforeEach(() => __resetProjectEditorBridgeForTesting())

describe("project-editor-bridge", () => {
  it("returns false when no editor is registered", () => {
    expect(openInProjectEditor("/repo/a.ts")).toBe(false)
  })

  it("hands a deferred request to an editor that mounts afterwards", () => {
    const open = jest.fn()

    deferProjectEditorOpen("/repo/src/a.ts", 8, 3)
    registerProjectEditorOpener({ root: "/repo", open })

    expect(open).toHaveBeenCalledWith("src/a.ts", 8, 3)
  })

  it("can wait for the next editor mount instead of using a dormant opener", () => {
    const dormant = jest.fn()
    const mounted = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open: dormant })

    deferProjectEditorOpen("/repo/src/a.ts", 8, 3)
    expect(dormant).not.toHaveBeenCalled()
    registerProjectEditorOpener({ root: "/repo", open: mounted })

    expect(mounted).toHaveBeenCalledWith("src/a.ts", 8, 3)
    expect(dormant).not.toHaveBeenCalled()
  })

  it("routes an in-root path to the opener with a relative path", () => {
    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })
    expect(openInProjectEditor("/repo/src/a.ts", 5, 2)).toBe(true)
    expect(open).toHaveBeenCalledWith("src/a.ts", 5, 2)
  })

  it("routes Windows paths using normalized separators", () => {
    const open = jest.fn()
    registerProjectEditorOpener({ root: "C:\\repo", open })

    expect(openInProjectEditor("C:\\repo\\src\\a.ts", 5, 2)).toBe(true)
    expect(open).toHaveBeenCalledWith("src/a.ts", 5, 2)
  })

  it("ignores a path outside every root", () => {
    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })
    expect(openInProjectEditor("/elsewhere/a.ts")).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it("does not match a sibling-prefixed root", () => {
    registerProjectEditorOpener({ root: "/repo", open: jest.fn() })
    expect(openInProjectEditor("/repo2/a.ts")).toBe(false)
  })

  it("returns false when the path IS the root (no file to open)", () => {
    registerProjectEditorOpener({ root: "/repo", open: jest.fn() })
    expect(openInProjectEditor("/repo")).toBe(false)
  })

  it("picks the deepest matching root for nested worktrees", () => {
    const outer = jest.fn()
    const inner = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open: outer })
    registerProjectEditorOpener({ root: "/repo/packages/inner", open: inner })
    openInProjectEditor("/repo/packages/inner/x.ts")
    expect(inner).toHaveBeenCalledWith("x.ts", undefined, undefined)
    expect(outer).not.toHaveBeenCalled()
  })

  it("prefers the most recently mounted opener for an equal root", () => {
    const dormant = jest.fn()
    const mounted = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open: dormant })
    registerProjectEditorOpener({ root: "/repo", open: mounted })

    openInProjectEditor("/repo/a.ts", 2, 3)

    expect(mounted).toHaveBeenCalledWith("a.ts", 2, 3)
    expect(dormant).not.toHaveBeenCalled()
  })

  it("unregister stops routing", () => {
    const open = jest.fn()
    const dispose = registerProjectEditorOpener({ root: "/repo", open })
    dispose()
    expect(openInProjectEditor("/repo/a.ts")).toBe(false)
  })
})
