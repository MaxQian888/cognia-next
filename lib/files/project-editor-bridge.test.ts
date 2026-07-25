import {
  registerProjectEditorOpener,
  openInProjectEditor,
  readActiveFromProjectEditor,
  reflectEditInProjectEditor,
  deferProjectEditorOpen,
  __resetProjectEditorBridgeForTesting,
  type ActiveEditorContext,
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

  describe("reflectEditInProjectEditor", () => {
    it("routes to applyEdit when the editor supports it", () => {
      const open = jest.fn()
      const applyEdit = jest.fn()
      registerProjectEditorOpener({ root: "/repo", open, applyEdit })

      expect(reflectEditInProjectEditor("/repo/src/a.ts", 5, 2)).toBe(true)
      expect(applyEdit).toHaveBeenCalledWith("src/a.ts", 5, 2)
      expect(open).not.toHaveBeenCalled()
    })

    it("falls back to open when the editor has no applyEdit", () => {
      const open = jest.fn()
      registerProjectEditorOpener({ root: "/repo", open })

      expect(reflectEditInProjectEditor("/repo/src/a.ts", 5, 2)).toBe(true)
      expect(open).toHaveBeenCalledWith("src/a.ts", 5, 2)
    })

    it("returns false when no editor is rooted at the path", () => {
      expect(reflectEditInProjectEditor("/repo/src/a.ts")).toBe(false)
    })
  })

  describe("readActiveFromProjectEditor", () => {
    const snapshot = (path: string): ActiveEditorContext => ({
      path,
      selection: null,
      selectedText: null,
      diagnostics: [],
      openEditors: [path],
    })

    it("returns null when nothing is registered", async () => {
      await expect(readActiveFromProjectEditor("/repo")).resolves.toBeNull()
    })

    it("reads through the editor rooted at the requested root", async () => {
      const readActive = jest.fn().mockResolvedValue(snapshot("/repo/src/a.ts"))
      registerProjectEditorOpener({ root: "/repo", open: jest.fn(), readActive })

      await expect(readActiveFromProjectEditor("/repo")).resolves.toEqual(
        snapshot("/repo/src/a.ts")
      )
    })

    it("accepts a bare root, which the write-side resolution rejects", async () => {
      // `openInProjectEditor` needs a file *inside* the root and returns false
      // for the root itself; a read is asked per root, so it must not inherit
      // that rule.
      const readActive = jest.fn().mockResolvedValue(snapshot("/repo/src/a.ts"))
      registerProjectEditorOpener({ root: "/repo", open: jest.fn(), readActive })

      expect(openInProjectEditor("/repo")).toBe(false)
      await expect(readActiveFromProjectEditor("/repo")).resolves.not.toBeNull()
    })

    it("skips a dormant opener that cannot read and picks the live editor", async () => {
      // The dock's reveal opener registers first and only queues a reveal — it
      // has no editor behind it. The write side deliberately prefers the LATEST
      // registration for equal roots, so a read that reused that rule would
      // pick whichever registered last regardless of whether it can answer.
      const readActive = jest.fn().mockResolvedValue(snapshot("/repo/src/a.ts"))
      registerProjectEditorOpener({ root: "/repo", open: jest.fn(), readActive })
      registerProjectEditorOpener({ root: "/repo", open: jest.fn() })

      await expect(readActiveFromProjectEditor("/repo")).resolves.toEqual(
        snapshot("/repo/src/a.ts")
      )
      expect(readActive).toHaveBeenCalled()
    })

    it("prefers the deepest matching root for nested worktrees", async () => {
      const outer = jest.fn().mockResolvedValue(snapshot("/repo/a.ts"))
      const inner = jest.fn().mockResolvedValue(snapshot("/repo/nested/b.ts"))
      registerProjectEditorOpener({ root: "/repo", open: jest.fn(), readActive: outer })
      registerProjectEditorOpener({ root: "/repo/nested", open: jest.fn(), readActive: inner })

      await expect(readActiveFromProjectEditor("/repo/nested")).resolves.toEqual(
        snapshot("/repo/nested/b.ts")
      )
      expect(outer).not.toHaveBeenCalled()
    })

    it("returns null for a root no registered editor covers", async () => {
      registerProjectEditorOpener({ root: "/repo", open: jest.fn(), readActive: jest.fn() })

      await expect(readActiveFromProjectEditor("/elsewhere")).resolves.toBeNull()
    })

    it("stops reading once the editor unregisters", async () => {
      const unregister = registerProjectEditorOpener({
        root: "/repo",
        open: jest.fn(),
        readActive: jest.fn().mockResolvedValue(snapshot("/repo/src/a.ts")),
      })

      unregister()
      await expect(readActiveFromProjectEditor("/repo")).resolves.toBeNull()
    })
  })
})
