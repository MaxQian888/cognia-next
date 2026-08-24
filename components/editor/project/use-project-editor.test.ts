/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react"
import { useProjectEditor, joinRootRel, type ProjectEditorDeps } from "./use-project-editor"
import {
  getModelRetainCount,
  getRetainedModelUris,
  resetMonacoModelRegistry,
} from "@/lib/editor-workbench/monaco-model-registry"

const mockSessionsToArray = jest.fn().mockResolvedValue([])
const mockSessionUpdate = jest.fn().mockResolvedValue(1)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: { toArray: mockSessionsToArray, update: mockSessionUpdate },
  }),
}))

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  const ns = { ...child, child: () => child }
  return {
    loggers: { agent: ns, plugin: ns, canvas: ns },
    createLogger: () => ns,
    logger: ns,
  }
})

// Minimal in-memory project-editor-session-store stub.
const sessionStore: Record<string, unknown> = {}
const setEditorSession = jest.fn((scopeKey: string, patch: Record<string, unknown>) => {
  sessionStore[scopeKey] = { ...(sessionStore[scopeKey] as object), ...patch }
})
let mockPersisted: unknown = undefined
jest.mock("@/stores/editor/project-editor-session-store", () => ({
  useProjectEditorSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ sessions: { "team:team1": mockPersisted }, setSession: setEditorSession }),
}))

function makeDeps(overrides: Partial<ProjectEditorDeps> = {}): Partial<ProjectEditorDeps> {
  const files: Record<string, string> = {
    "src/a.ts": "export const a = 1\n",
    "src/b.ts": "export const b = 2\n",
  }
  return {
    listDir: jest.fn(async () => []),
    readFile: jest.fn(async (_root: string, rel: string) => files[rel] ?? ""),
    statFile: jest.fn(async () => ({ exists: true, isDir: false, size: 10, mtimeMs: 1234 })),
    writeFile: jest.fn(async (_root: string, rel: string, content: string) => {
      files[rel] = content
    }),
    createDir: jest.fn(async () => {}),
    deleteEntry: jest.fn(async () => {}),
    renameEntry: jest.fn(async () => {}),
    listWorktrees: jest.fn(async () => [
      {
        path: "/repo",
        branch: "main",
        head: "h",
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        isMain: true,
      },
      {
        path: "/repo-wt",
        branch: "feature/x",
        head: "h2",
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
        isMain: false,
      },
    ]),
    registerLspRoot: jest.fn(() => "file:///repo"),
    unregisterLspRoot: jest.fn(),
    watch: jest.fn(() => () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  mockPersisted = undefined
  setEditorSession.mockClear()
  for (const k of Object.keys(sessionStore)) delete sessionStore[k]
  mockSessionsToArray.mockReset().mockResolvedValue([])
  mockSessionUpdate.mockReset().mockResolvedValue(1)
  resetMonacoModelRegistry()
})

describe("joinRootRel", () => {
  it("joins and trims trailing slashes", () => {
    expect(joinRootRel("/repo/", "src/a.ts")).toBe("/repo/src/a.ts")
    expect(joinRootRel("/repo", "")).toBe("/repo")
  })
})

describe("useProjectEditor", () => {
  it("registers the LSP root and discovers worktrees", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(result.current.roots.length).toBe(2))
    expect(result.current.roots.map((r) => r.label)).toEqual(["main", "feature/x"])
    expect(deps.registerLspRoot).toHaveBeenCalledWith("/repo")
  })

  it("opens a file, tracks dirty on edit, and saves", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect(result.current.openFiles).toHaveLength(1)
    expect(result.current.activeFile?.language).toBe("typescript")
    expect(result.current.activeFile?.mtime).toBe(1234)
    expect(result.current.dirtyCount).toBe(0)

    act(() => result.current.setDraft("src/a.ts", "changed\n"))
    expect(result.current.dirtyCount).toBe(1)

    await act(async () => {
      await result.current.saveFile("src/a.ts")
    })
    expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "changed\n")
    expect(result.current.dirtyCount).toBe(0)
  })

  it("does not re-read an already-open file, just re-activates it", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
      await result.current.openFile("src/a.ts")
    })
    expect(result.current.openFiles).toHaveLength(2)
    expect(result.current.activePath).toBe("src/a.ts")
    expect((deps.readFile as jest.Mock).mock.calls.filter((c) => c[1] === "src/a.ts")).toHaveLength(
      1
    )
  })

  it("moves an open model when an in-app file rename is confirmed", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => result.current.openFile("src/a.ts"))
    await act(() => result.current.renameOpenFile("src/a.ts", "src/renamed.ts"))
    expect(result.current.activeFile).toMatchObject({
      relPath: "src/renamed.ts",
      absolutePath: "/repo/src/renamed.ts",
    })
  })

  it("closing the active tab falls back to a neighbour", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    act(() => result.current.closeFile("src/b.ts"))
    expect(result.current.activePath).toBe("src/a.ts")
    act(() => result.current.closeFile("src/a.ts"))
    expect(result.current.activePath).toBeNull()
  })

  it("saveAll writes every dirty file", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    act(() => {
      result.current.setDraft("src/a.ts", "A\n")
      result.current.setDraft("src/b.ts", "B\n")
    })
    await act(async () => {
      await result.current.saveAll()
    })
    expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "A\n")
    expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/b.ts", "B\n")
    expect(result.current.dirtyCount).toBe(0)
  })

  it("switching root clears open files and re-registers LSP", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    await waitFor(() => expect(result.current.roots.length).toBe(2))
    act(() => result.current.selectRoot("/repo-wt"))
    expect(result.current.openFiles).toHaveLength(0)
    await waitFor(() => expect(deps.registerLspRoot).toHaveBeenCalledWith("/repo-wt"))
    expect(deps.unregisterLspRoot).toHaveBeenCalledWith("/repo")
  })

  it("persists the session on change", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect(setEditorSession).toHaveBeenCalledWith(
      "team:team1",
      expect.objectContaining({ rootKey: "/repo", openPaths: ["src/a.ts"], activePath: "src/a.ts" })
    )
  })

  it("restores a persisted session on mount", async () => {
    mockPersisted = { rootKey: "/repo", openPaths: ["src/b.ts"], activePath: "src/b.ts" }
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(result.current.openFiles).toHaveLength(1))
    expect(result.current.openFiles[0]?.relPath).toBe("src/b.ts")
    expect(result.current.activePath).toBe("src/b.ts")
  })

  it("swallows a read error on open (no tab added)", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async () => {
        throw new Error("EACCES")
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect(result.current.openFiles).toHaveLength(0)
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect((deps.readFile as jest.Mock).mock.calls.length).toBe(2)
  })

  it("saveFile is a no-op for an unopened file", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.saveFile("ghost.ts")
    })
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it("reloadFile swallows a read error", async () => {
    const readFile = jest
      .fn()
      .mockResolvedValueOnce("export const a = 1\n")
      .mockRejectedValueOnce(new Error("gone"))
    const deps = makeDeps({ readFile })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    await act(async () => {
      await result.current.reloadFile("src/a.ts")
    })
    expect(result.current.openFiles).toHaveLength(1)
  })

  it("tolerates a worktree-list failure (keeps the main root)", async () => {
    const deps = makeDeps({
      listWorktrees: jest.fn(async () => {
        throw new Error("not a repo")
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(deps.listWorktrees).toHaveBeenCalled())
    expect(result.current.roots).toEqual([
      { key: "/repo", label: "main", path: "/repo", isMain: true },
    ])
  })

  it("does not restore a session whose root differs from the current root", async () => {
    mockPersisted = { rootKey: "/other-root", openPaths: ["src/a.ts"], activePath: "src/a.ts" }
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(deps.listWorktrees).toHaveBeenCalled())
    expect(result.current.openFiles).toHaveLength(0)
  })

  it("flags an open file when it changes on disk externally", async () => {
    let fireChange: ((c: { kind: "modify"; path: string }) => void) | null = null
    const deps = makeDeps({
      watch: jest.fn((_root, cb) => {
        fireChange = cb
        return () => {}
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => fireChange?.({ kind: "modify", path: "/repo/src/a.ts" }))
    expect(result.current.openFiles[0]?.externallyChanged).toBe(true)

    await act(async () => {
      await result.current.reloadFile("src/a.ts")
    })
    expect(result.current.openFiles[0]?.externallyChanged).toBe(false)
  })
  describe("monaco model holds", () => {
    // Open documents — not editor mounts — are what keep a model and its undo
    // stack alive. These pin the retain/release pairs that make that true.
    it("retains a model per open document and releases it on close", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)

      // Re-activating an already-open file must not double-retain.
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)

      act(() => result.current.closeFile("src/a.ts"))
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
    })

    it("releases the hold when the file could not be read", async () => {
      const deps = makeDeps({
        readFile: jest.fn(async () => {
          throw new Error("nope")
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      expect(getRetainedModelUris()).toEqual([])
    })

    it("moves the hold to the new uri when a file is renamed", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      await act(async () => {
        await result.current.renameOpenFile("src/a.ts", "src/renamed.ts")
      })
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
      expect(getModelRetainCount("file:///repo/src/renamed.ts")).toBe(1)
    })

    it("drops every hold when the project root switches", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      expect(getRetainedModelUris()).toHaveLength(2)

      await waitFor(() => expect(result.current.roots).toHaveLength(2))
      act(() => result.current.selectRoot("/repo-wt"))
      expect(getRetainedModelUris()).toEqual([])
    })

    it("drops every hold when the editor unmounts", async () => {
      const deps = makeDeps()
      const { result, unmount } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      expect(getRetainedModelUris()).toHaveLength(1)

      unmount()
      expect(getRetainedModelUris()).toEqual([])
    })
  })
  describe("preview and pinned tabs", () => {
    it("reuses the single preview slot instead of stacking tabs", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
      })
      expect(result.current.previewPath).toBe("src/a.ts")

      await act(async () => {
        await result.current.openFile("src/b.ts", { mode: "preview" })
      })
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts"])
      expect(result.current.previewPath).toBe("src/b.ts")
      expect(result.current.activePath).toBe("src/b.ts")
      // The evicted preview must not keep its model alive.
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
    })

    it("does not resurrect a preview evicted while its read was still in flight", async () => {
      // Fast A→B clicking: A's `readFile` is still pending when B claims the
      // single preview slot and evicts A. The resolved read must not append A
      // back — that would leave two files in a one-slot dock.
      const gate: Record<string, (content: string) => void> = {}
      const deps = makeDeps({
        readFile: jest.fn(
          (_root: string, rel: string) =>
            new Promise<string>((resolve) => {
              gate[rel] = resolve
            })
        ),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )

      await act(async () => {
        // `openFile` resolves the tab transition off refs before it awaits, so
        // both calls interleave exactly as two fast clicks would.
        const openA = result.current.openFile("src/a.ts", { mode: "preview" })
        const openB = result.current.openFile("src/b.ts", { mode: "preview" })
        gate["src/b.ts"]?.("export const b = 2\n")
        gate["src/a.ts"]?.("export const a = 1\n")
        await Promise.all([openA, openB])
      })

      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts"])
      expect(result.current.previewPath).toBe("src/b.ts")
      expect(result.current.activePath).toBe("src/b.ts")
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
    })

    it("lets a stale failed read tear down only the tab it opened", async () => {
      // A → B → A. The first A read is still pending when A is re-opened, so
      // when it finally fails it must not close the *second* A: that tab is
      // live, active, and holds its own model.
      const gate: Record<string, { fail: (error: Error) => void }> = {}
      const pending: Array<{ rel: string; resolve: (content: string) => void }> = []
      const deps = makeDeps({
        readFile: jest.fn(
          (_root: string, rel: string) =>
            new Promise<string>((resolve, reject) => {
              gate[rel] = { fail: reject }
              pending.push({ rel, resolve })
            })
        ),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )

      await act(async () => {
        const staleA = result.current.openFile("src/a.ts", { mode: "preview" })
        const failStaleA = gate["src/a.ts"]!.fail
        const openB = result.current.openFile("src/b.ts", { mode: "preview" })
        pending.find((p) => p.rel === "src/b.ts")?.resolve("export const b = 2\n")
        await openB

        // A comes back, starting a second read that will succeed.
        const freshA = result.current.openFile("src/a.ts", { mode: "preview" })
        failStaleA(new Error("disk went away"))
        await staleA
        pending.at(-1)?.resolve("export const a = 1\n")
        await freshA
      })

      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
      expect(result.current.activePath).toBe("src/a.ts")
      expect(getRetainedModelUris()).toEqual(["file:///repo/src/a.ts"])
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)
    })

    it("defaults to a pinned tab so existing callers keep stacking", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      expect(result.current.openFiles).toHaveLength(2)
      expect(result.current.previewPath).toBeNull()
    })

    it("never evicts a pinned tab", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts", { mode: "preview" })
      })
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
    })

    it("pins the preview explicitly", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
      })
      act(() => result.current.pinFile("src/a.ts"))
      expect(result.current.previewPath).toBeNull()

      await act(async () => {
        await result.current.openFile("src/b.ts", { mode: "preview" })
      })
      expect(result.current.openFiles).toHaveLength(2)
    })

    it("pins the preview when the user starts editing it", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
      })
      act(() => result.current.setDraft("src/a.ts", "edited\n"))
      expect(result.current.previewPath).toBeNull()

      await act(async () => {
        await result.current.openFile("src/b.ts", { mode: "preview" })
      })
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
      expect(result.current.dirtyCount).toBe(1)
    })

    it("promotes the preview when it is re-opened as pinned", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
        await result.current.openFile("src/a.ts", { mode: "pinned" })
      })
      expect(result.current.previewPath).toBeNull()
      expect(result.current.openFiles).toHaveLength(1)
    })

    it("frees the preview slot on close, rename and root switch", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
      })
      act(() => result.current.closeFile("src/a.ts"))
      expect(result.current.previewPath).toBeNull()

      await act(async () => {
        await result.current.openFile("src/a.ts", { mode: "preview" })
      })
      await act(() => result.current.renameOpenFile("src/a.ts", "src/renamed.ts"))
      expect(result.current.previewPath).toBe("src/renamed.ts")

      await waitFor(() => expect(result.current.roots).toHaveLength(2))
      act(() => result.current.selectRoot("/repo-wt"))
      expect(result.current.previewPath).toBeNull()
    })
  })
  describe("resource-session rebinding on rename", () => {
    it("migrates only the sessions bound to this project's renamed files", async () => {
      mockSessionsToArray.mockResolvedValue([
        {
          id: "s1",
          kind: "resource-workbench",
          surfaceBinding: {
            kind: "project-file",
            projectId: "team:team1",
            rootId: "/repo",
            relPath: "src/a.ts",
          },
        },
        // Same file, different project — must not be touched.
        {
          id: "s2",
          kind: "resource-workbench",
          surfaceBinding: {
            kind: "project-file",
            projectId: "team:other",
            rootId: "/repo",
            relPath: "src/a.ts",
          },
        },
        // Same project, different root — must not be touched.
        {
          id: "s3",
          kind: "resource-workbench",
          surfaceBinding: {
            kind: "project-file",
            projectId: "team:team1",
            rootId: "/elsewhere",
            relPath: "src/a.ts",
          },
        },
        // Bound to a file the rename does not affect.
        {
          id: "s4",
          kind: "resource-workbench",
          surfaceBinding: {
            kind: "project-file",
            projectId: "team:team1",
            rootId: "/repo",
            relPath: "src/untouched.ts",
          },
        },
        // Not a resource-workbench session at all.
        { id: "s5", kind: "chat", surfaceBinding: undefined },
        // Resource workbench over a different surface kind.
        {
          id: "s6",
          kind: "resource-workbench",
          surfaceBinding: { kind: "canvas-document", documentId: "d1" },
        },
      ])
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      await act(() => result.current.renameOpenFile("src/a.ts", "src/z.ts"))

      expect(mockSessionUpdate).toHaveBeenCalledTimes(1)
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          surfaceBinding: expect.objectContaining({ relPath: "src/z.ts" }),
        })
      )
    })

    it("migrates descendants when a directory is renamed", async () => {
      mockSessionsToArray.mockResolvedValue([
        {
          id: "s1",
          kind: "resource-workbench",
          surfaceBinding: {
            kind: "project-file",
            projectId: "team:team1",
            rootId: "/repo",
            relPath: "src/a.ts",
          },
        },
      ])
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      await act(() => result.current.renameOpenFile("src", "lib"))

      expect(result.current.activeFile).toMatchObject({
        relPath: "lib/a.ts",
        absolutePath: "/repo/lib/a.ts",
      })
      expect(getModelRetainCount("file:///repo/lib/a.ts")).toBe(1)
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          surfaceBinding: expect.objectContaining({ relPath: "lib/a.ts" }),
        })
      )
    })

    it("still renames the open tabs when the session lookup fails", async () => {
      mockSessionsToArray.mockRejectedValue(new Error("db down"))
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      await act(() => result.current.renameOpenFile("src/a.ts", "src/z.ts"))
      expect(result.current.activeFile?.relPath).toBe("src/z.ts")
    })
  })

  describe("mtime bookkeeping when stat fails", () => {
    it("keeps the previous mtime after a save whose stat call rejects", async () => {
      let statCalls = 0
      const deps = makeDeps({
        statFile: jest.fn(async () => {
          statCalls += 1
          if (statCalls === 1) return { exists: true, isDir: false, size: 10, mtimeMs: 1234 }
          throw new Error("stat failed")
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "changed\n"))
      await act(async () => {
        await result.current.saveFile("src/a.ts")
      })
      expect(result.current.activeFile?.mtime).toBe(1234)
      expect(result.current.dirtyCount).toBe(0)
    })

    it("keeps the previous mtime after saveAll and reload when stat rejects", async () => {
      let statCalls = 0
      const deps = makeDeps({
        statFile: jest.fn(async () => {
          statCalls += 1
          if (statCalls === 1) return { exists: true, isDir: false, size: 10, mtimeMs: 999 }
          throw new Error("stat failed")
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "changed\n"))
      await act(async () => {
        await result.current.saveAll()
      })
      expect(result.current.activeFile?.mtime).toBe(999)

      await act(async () => {
        await result.current.reloadFile("src/a.ts")
      })
      expect(result.current.activeFile?.mtime).toBe(999)
    })
  })
  it("leaves the other open files untouched on save, reload and rename", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    const untouched = result.current.openFiles.find((f) => f.relPath === "src/b.ts")

    act(() => result.current.setDraft("src/a.ts", "changed\n"))
    await act(async () => {
      await result.current.saveFile("src/a.ts")
    })
    expect(result.current.openFiles.find((f) => f.relPath === "src/b.ts")).toBe(untouched)

    await act(async () => {
      await result.current.reloadFile("src/a.ts")
    })
    expect(result.current.openFiles.find((f) => f.relPath === "src/b.ts")).toBe(untouched)

    await act(() => result.current.renameOpenFile("src/a.ts", "src/z.ts"))
    expect(result.current.openFiles.find((f) => f.relPath === "src/b.ts")).toBe(untouched)
    expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/z.ts", "src/b.ts"])
  })
  it("does not double-hold a model when a rename lands on an already-open file", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    // Renaming a.ts onto b.ts's path: b.ts already holds that uri, so the
    // retain must be idempotent rather than leaving a hold nobody releases.
    await act(() => result.current.renameOpenFile("src/a.ts", "src/b.ts"))
    expect(getModelRetainCount("file:///repo/src/b.ts")).toBe(1)
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
  })

  it("ignores a close for a file whose open never completed", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async () => {
        throw new Error("nope")
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect(getRetainedModelUris()).toEqual([])
    act(() => result.current.closeFile("src/a.ts"))
    expect(getRetainedModelUris()).toEqual([])
  })
})
