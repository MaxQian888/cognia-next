/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react"
import { useProjectEditor, joinRootRel, type ProjectEditorDeps } from "./use-project-editor"

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
      { path: "/repo", branch: "main", head: "h", isMain: true },
      { path: "/repo-wt", branch: "feature/x", head: "h2", isMain: false },
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
})
