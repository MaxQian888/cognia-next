/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react"
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  useProjectEditor,
  joinRootRel,
  MAX_EDITOR_BYTES,
  type ProjectEditorDeps,
} from "./use-project-editor"
import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"
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
let mockRemoteActive = false
let mockHostChanged: (() => void) | undefined
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockRemoteActive,
  subscribeActiveRemoteTransport: (handler: () => void) => {
    mockHostChanged = handler
    return () => {}
  },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  onTransportChange: () => () => {},
  transport: { call: jest.fn() },
}))
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
  mockRemoteActive = false
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

  describe("closed-tab history", () => {
    it("reopens the most recently closed tab", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      act(() => result.current.closeFile("src/b.ts"))
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.openFiles.map((f) => f.relPath)).toContain("src/b.ts")
      expect(result.current.activePath).toBe("src/b.ts")
    })

    it("pops a batch close in tab order, most recent first", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
        await result.current.openFile("src/c.ts")
      })
      act(() => result.current.closeAllFiles())
      expect(result.current.openFiles).toHaveLength(0)
      // History pushes in tab order and pops from the tail — the rightmost
      // closed tab comes back first, like VS Code's reopen-closed.
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.activePath).toBe("src/c.ts")
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.activePath).toBe("src/b.ts")
    })

    it("is a no-op on an empty history", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.openFiles).toHaveLength(0)
      expect(deps.readFile).not.toHaveBeenCalled()
    })

    it("does not stack the same path twice", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.closeFile("src/a.ts"))
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.closeFile("src/a.ts"))
      // One reopen consumes the single history entry — a second is a no-op
      // and must not resurrect a stale stack frame.
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.activePath).toBe("src/a.ts")
      await act(async () => result.current.openFile("src/b.ts"))
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.activePath).toBe("src/b.ts")
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
    })

    it("follows an in-app rename", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.closeFile("src/a.ts"))
      await act(async () => result.current.renameOpenFile("src/a.ts", "src/renamed.ts"))
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.activePath).toBe("src/renamed.ts")
    })

    it("forgets the history when the root switches", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.closeFile("src/a.ts"))
      await waitFor(() => expect(result.current.roots.length).toBe(2))
      act(() => result.current.selectRoot("/repo-wt"))
      // A relPath only resolves inside its own root — reopening the old
      // root's history under /repo-wt would open (or fail on) the wrong file.
      await act(async () => result.current.reopenClosedFile())
      expect(result.current.openFiles).toHaveLength(0)
    })

    it("caps the history so the oldest entries fall off", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        for (let i = 1; i <= 21; i++) await result.current.openFile(`src/f${i}.ts`)
      })
      act(() => result.current.closeAllFiles())
      for (let i = 0; i < 21; i++) {
        await act(async () => result.current.reopenClosedFile())
      }
      const reopened = result.current.openFiles.map((f) => f.relPath)
      expect(reopened).toHaveLength(20)
      expect(reopened).not.toContain("src/f1.ts")
      expect(reopened).toContain("src/f2.ts")
    })
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

  it("keeps text typed during a delayed save dirty", async () => {
    let finish!: () => void
    const deps = makeDeps({
      writeFile: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      ),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "sent"))
    let saving!: Promise<boolean>
    // The save passes through an (awaited) confirm gate before writing, so
    // `finish` lands a microtask in — an async act flushes that far.
    await act(async () => {
      saving = result.current.saveFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "newer draft"))
    await act(async () => {
      finish()
      await saving
    })
    expect(result.current.activeFile).toMatchObject({
      savedContent: "sent",
      draftContent: "newer draft",
    })
    expect(result.current.dirtyCount).toBe(1)
  })

  it("acknowledges successful files when a later saveAll write fails", async () => {
    const deps = makeDeps({
      writeFile: jest.fn(async (_root, rel) => {
        if (rel === "src/b.ts") throw new Error("offline")
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    act(() => {
      result.current.setDraft("src/a.ts", "a changed")
      result.current.setDraft("src/b.ts", "b changed")
    })
    await act(async () => {
      await expect(result.current.saveAll()).rejects.toThrow("offline")
    })
    expect(result.current.openFiles[0].savedContent).toBe("a changed")
    expect(result.current.openFiles[1].savedContent).not.toBe("b changed")
    expect(result.current.dirtyCount).toBe(1)
  })

  it("serializes saves of one file so an older request cannot overwrite a newer save", async () => {
    const finishes: (() => void)[] = []
    const deps = makeDeps({
      writeFile: jest.fn(() => new Promise<void>((resolve) => finishes.push(resolve))),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "first"))
    let first!: Promise<boolean>
    await act(async () => {
      first = result.current.saveFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "second"))
    let second!: Promise<boolean>
    await act(async () => {
      second = result.current.saveFile("src/a.ts")
    })
    expect(deps.writeFile).toHaveBeenCalledTimes(1)
    await act(async () => {
      finishes[0]()
      await first
    })
    expect(deps.writeFile).toHaveBeenNthCalledWith(2, "/repo", "src/a.ts", "second")
    await act(async () => {
      finishes[1]()
      await second
    })
    expect(result.current.activeFile?.savedContent).toBe("second")
  })

  it("refuses to send an old host's draft to a newly selected host", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => {
      result.current.setDraft("src/a.ts", "private draft")
      mockHostChanged?.()
    })
    await expect(result.current.saveFile("src/a.ts")).rejects.toThrow("workspace host changed")
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(result.current.dirtyCount).toBe(1)
  })

  it("does not authorize an old draft on a new host after a failed reload", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => {
      result.current.setDraft("src/a.ts", "old host draft")
      mockHostChanged?.()
    })
    jest.mocked(deps.readFile!).mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      await expect(result.current.reloadFile("src/a.ts")).rejects.toThrow("offline")
    })
    await expect(result.current.saveFile("src/a.ts")).rejects.toThrow("workspace host changed")
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(result.current.activeFile?.draftContent).toBe("old host draft")
  })

  it("does not send queued saveAll snapshots after switching host and reloading paths", async () => {
    let finish!: () => void
    const write = jest
      .fn()
      .mockResolvedValue(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
    const deps = makeDeps({ writeFile: write })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
      await result.current.openFile("src/b.ts")
    })
    act(() => {
      result.current.setDraft("src/a.ts", "old a")
      result.current.setDraft("src/b.ts", "old b")
    })
    let outcome!: Promise<unknown>
    act(() => {
      outcome = result.current.saveAll().catch((error: unknown) => error)
    })
    act(() => mockHostChanged?.())
    await act(async () => {
      await result.current.reloadFile("src/b.ts")
    })
    await act(async () => {
      finish()
      await outcome
    })
    expect(await outcome).toEqual(
      expect.objectContaining({ message: expect.stringContaining("workspace host changed") })
    )
    expect(deps.writeFile).toHaveBeenCalledTimes(1)
    expect(result.current.openFiles.find((file) => file.relPath === "src/b.ts")?.savedContent).toBe(
      "export const b = 2\n"
    )
  })

  it("ignores an old save acknowledgement after a close and reopen", async () => {
    let finish!: () => void
    const deps = makeDeps({
      writeFile: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      ),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    let saving!: Promise<boolean>
    act(() => {
      saving = result.current.saveFile("src/a.ts")
      result.current.closeFile("src/a.ts")
    })
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "reopened draft"))
    await act(async () => {
      finish()
      await saving
    })
    expect(result.current.activeFile?.savedContent).toBe("export const a = 1\n")
    expect(result.current.dirtyCount).toBe(1)
  })

  it("polls remote metadata without downloading or overwriting dirty text", async () => {
    mockRemoteActive = true
    jest.useFakeTimers()
    try {
      const deps = makeDeps()
      const { result, unmount } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "local draft"))
      jest
        .mocked(deps.statFile!)
        .mockResolvedValue({ exists: true, isDir: false, size: 30, mtimeMs: 9999 })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000)
      })
      expect(result.current.activeFile).toMatchObject({
        draftContent: "local draft",
        externallyChanged: true,
      })
      expect(deps.readFile).toHaveBeenCalledTimes(1)
      const calls = jest.mocked(deps.statFile!).mock.calls.length
      unmount()
      await jest.advanceTimersByTimeAsync(10000)
      expect(deps.statFile).toHaveBeenCalledTimes(calls)
    } finally {
      jest.useRealTimers()
    }
  })

  it("pauses metadata requests while hidden and resumes without overlapping a slow request", async () => {
    jest.useFakeTimers()
    const visibility = jest.spyOn(document, "visibilityState", "get")
    visibility.mockReturnValue("hidden")
    try {
      const deps = makeDeps()
      const { result, unmount } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000)
      })
      expect(deps.statFile).toHaveBeenCalledTimes(1)
      let finish!: (value: Awaited<ReturnType<ProjectEditorDeps["statFile"]>>) => void
      jest.mocked(deps.statFile!).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      visibility.mockReturnValue("visible")
      act(() => document.dispatchEvent(new Event("visibilitychange")))
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20000)
        window.dispatchEvent(new Event("online"))
      })
      expect(deps.statFile).toHaveBeenCalledTimes(2)
      await act(async () => {
        finish({ exists: false, isDir: false, size: 0, mtimeMs: null })
      })
      expect(result.current.activeFile?.deletedOnDisk).toBe(true)
      unmount()
    } finally {
      visibility.mockRestore()
      jest.useRealTimers()
    }
  })

  it("blocks truncated UTF-8 content when the metadata probe fails", async () => {
    const content = "字".repeat(Math.ceil(MAX_EDITOR_BYTES / 3)) + "\n... (truncated)"
    const deps = makeDeps({
      statFile: jest.fn().mockRejectedValue(new Error("metadata unavailable")),
      readFile: jest.fn().mockResolvedValue(content),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("notes.txt")
    })
    expect(result.current.activeFile).toMatchObject({ blocked: "too-large", draftContent: "" })
    await act(async () => {
      await result.current.saveFile("notes.txt")
    })
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it("verifies saved bytes and dirty state against a real Unicode file on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "cognia-editor-sync-"))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await writeFile(join(root, "note.md"), "原始文本\n", "utf8")
    const deps = makeDeps({
      listWorktrees: async () => [],
      readFile: async (dir, rel) => readFile(join(dir, rel), "utf8"),
      statFile: async (dir, rel) => {
        const value = await stat(join(dir, rel))
        return { exists: true, isDir: false, size: value.size, mtimeMs: value.mtimeMs }
      },
      writeFile: async (dir, rel, content) => {
        await gate
        await writeFile(join(dir, rel), content, "utf8")
      },
    })
    const { result, unmount } = renderHook(() =>
      useProjectEditor({ scopeKey: "disk-evidence", workingDir: root, deps })
    )
    try {
      await act(async () => {
        await result.current.openFile("note.md")
      })
      await waitFor(() => expect(result.current.activeFile?.draftContent).toBe("原始文本\n"))
      act(() => result.current.setDraft("note.md", "已发送 😀\n"))
      let saving!: Promise<boolean>
      act(() => {
        saving = result.current.saveFile("note.md")
      })
      act(() => result.current.setDraft("note.md", "尚未保存的新内容\n"))
      await act(async () => {
        release()
        await saving
      })
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("已发送 😀\n")
      expect(result.current.activeFile).toMatchObject({
        savedContent: "已发送 😀\n",
        draftContent: "尚未保存的新内容\n",
      })
      expect(result.current.dirtyCount).toBe(1)
      await act(async () => {
        await result.current.saveAll()
      })
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("尚未保存的新内容\n")
      expect(result.current.dirtyCount).toBe(0)
    } finally {
      unmount()
      await rm(root, { recursive: true, force: true })
    }
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
    expect(result.current.sessionRestored).toBe(true)
  })

  it("flips sessionRestored once the persisted open set is marked, before reads land", async () => {
    mockPersisted = {
      rootKey: "/repo",
      openPaths: ["src/a.ts", "src/b.ts"],
      activePath: "src/b.ts",
    }
    const resolvers: Array<() => void> = []
    const deps = makeDeps({
      readFile: jest.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(() => resolve("export const x = 1\n"))
          })
      ),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )

    await waitFor(() => expect(result.current.sessionRestored).toBe(true))
    // The reads are still suspended — the gate means every persisted path
    // has been marked, so `isPathOpen` answers for the whole set. Layout
    // restorers (workbench split groups) rely on exactly this moment.
    expect(result.current.openFiles).toHaveLength(0)
    expect(result.current.isPathOpen("src/a.ts")).toBe(true)
    expect(result.current.isPathOpen("src/b.ts")).toBe(true)
    // The first post-restore write already serializes the marked set —
    // materializing `openFiles` is not a prerequisite, and the record never
    // carries a transient empty `openPaths` during the restore window.
    expect(setEditorSession).toHaveBeenCalledWith(
      "team:team1",
      expect.objectContaining({ openPaths: ["src/a.ts", "src/b.ts"] })
    )
    expect(setEditorSession).not.toHaveBeenCalledWith(
      "team:team1",
      expect.objectContaining({ openPaths: [] })
    )

    await act(async () => {
      resolvers.forEach((resolve) => resolve())
    })
    await waitFor(() => expect(result.current.openFiles).toHaveLength(2))
    await waitFor(() =>
      expect(setEditorSession).toHaveBeenCalledWith(
        "team:team1",
        expect.objectContaining({ openPaths: ["src/a.ts", "src/b.ts"] })
      )
    )
  })

  it("flips sessionRestored even when no persisted session matches", async () => {
    mockPersisted = { rootKey: "/other-root", openPaths: ["src/a.ts"], activePath: "src/a.ts" }
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(result.current.sessionRestored).toBe(true))
    expect(result.current.openFiles).toHaveLength(0)
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

  it("reverts the selection to the previous file when the open read fails", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async (_root: string, rel: string) => {
        if (rel === "src/b.ts") throw new Error("EACCES")
        return "export const x = 1\n"
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    expect(result.current.activePath).toBe("src/a.ts")

    await act(async () => {
      await result.current.openFile("src/b.ts")
    })
    // The click moved `activePath` before the read settled; leaving it on a
    // file that never opened parked the selection on a phantom tab.
    expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
    expect(result.current.activePath).toBe("src/a.ts")
  })

  it("clears the selection and the preview tab when nothing else is open", async () => {
    const deps = makeDeps({
      readFile: jest.fn(async () => {
        throw new Error("EACCES")
      }),
    })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts", { mode: "preview" })
    })
    expect(result.current.activePath).toBeNull()
    expect(result.current.previewPath).toBeNull()
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

  it("reloadFile propagates a read error and keeps the tab, draft and model", async () => {
    const readFile = jest
      .fn()
      .mockResolvedValueOnce("export const a = 1\n")
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValue("export const a = 2\n")
    const deps = makeDeps({ readFile })
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    act(() => result.current.setDraft("src/a.ts", "unsaved\n"))
    // The caller (workbench revert) toasts on rejection — swallowing it here
    // would hide a real failure from the user.
    await act(async () => {
      await expect(result.current.reloadFile("src/a.ts")).rejects.toThrow("gone")
    })
    // The live tab survives a failed reload: draft, model hold and selection
    // all stay put instead of the strip losing the file.
    expect(result.current.openFiles).toHaveLength(1)
    expect(result.current.openFiles[0].draftContent).toBe("unsaved\n")
    expect(result.current.activePath).toBe("src/a.ts")
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)
    // A later retry still works.
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

  describe("external disk changes", () => {
    const fireableWatch = () => {
      let fire: ((c: WorkspaceFsChange) => void) | null = null
      const watch = jest.fn((_root: string, cb: (c: WorkspaceFsChange) => void) => {
        fire = cb
        return () => {}
      })
      return { watch, fire: (c: WorkspaceFsChange) => fire?.(c) }
    }

    it("auto-reloads a clean open file when it changes on disk", async () => {
      const { watch, fire } = fireableWatch()
      const files: Record<string, string> = { "src/a.ts": "v1\n" }
      const deps = makeDeps({
        watch,
        readFile: jest.fn(async (_root: string, rel: string) => files[rel] ?? ""),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      expect(result.current.openFiles[0]?.savedContent).toBe("v1\n")

      files["src/a.ts"] = "v2 — written by an agent\n"
      await act(async () => {
        fire({ kind: "modify", path: "/repo/src/a.ts" })
        await Promise.resolve()
      })
      // A clean buffer mirrors the disk write — no flag, fresh content.
      expect(result.current.openFiles[0]?.savedContent).toContain("v2")
      expect(result.current.openFiles[0]?.externallyChanged).toBe(false)
    })

    it("flags a dirty open file instead of reloading it", async () => {
      const { watch, fire } = fireableWatch()
      const deps = makeDeps({ watch })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "draft with unsaved work"))
      await act(async () => {
        fire({ kind: "modify", path: "/repo/src/a.ts" })
      })
      const file = result.current.openFiles[0]
      expect(file?.externallyChanged).toBe(true)
      expect(file?.draftContent).toBe("draft with unsaved work")

      await act(async () => {
        await result.current.reloadFile("src/a.ts")
      })
      expect(result.current.openFiles[0]?.externallyChanged).toBe(false)
    })

    it("ignores the echo of its own save", async () => {
      const { watch, fire } = fireableWatch()
      const deps = makeDeps({ watch })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "user edit"))
      await act(async () => {
        await result.current.saveFile("src/a.ts")
      })
      expect(result.current.openFiles[0]?.externallyChanged).toBeFalsy()

      // The fs watcher cannot tell our write from an agent's — the event must
      // be suppressed, not flagged.
      act(() => fire({ kind: "modify", path: "/repo/src/a.ts" }))
      expect(result.current.openFiles[0]?.externallyChanged).toBeFalsy()
    })

    it("marks an open file deletedOnDisk on a delete event", async () => {
      const { watch, fire } = fireableWatch()
      const deps = makeDeps({ watch })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => fire({ kind: "delete", path: "/repo/src/a.ts" }))
      expect(result.current.openFiles[0]?.deletedOnDisk).toBe(true)
      expect(result.current.openFiles[0]?.externallyChanged).toBeFalsy()
    })

    it("clears deletedOnDisk when the file is recreated", async () => {
      const { watch, fire } = fireableWatch()
      const deps = makeDeps({ watch })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => fire({ kind: "delete", path: "/repo/src/a.ts" }))
      expect(result.current.openFiles[0]?.deletedOnDisk).toBe(true)
      // Clean buffer + recreate → auto-reload clears the deleted flag.
      await act(async () => {
        fire({ kind: "create", path: "/repo/src/a.ts" })
        await Promise.resolve()
      })
      expect(result.current.openFiles[0]?.deletedOnDisk).toBeFalsy()
    })

    it("debounces the tree refresh across an event burst", async () => {
      jest.useFakeTimers()
      try {
        const { watch, fire } = fireableWatch()
        const deps = makeDeps({ watch })
        const { result } = renderHook(() =>
          useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
        )
        const token = () => result.current.treeRefreshToken
        await act(async () => {
          await result.current.openFile("src/a.ts")
        })
        const before = token()
        act(() => {
          for (let i = 0; i < 10; i += 1) {
            fire({ kind: "create", path: `/repo/burst/${i}.txt` })
          }
          jest.advanceTimersByTime(300)
        })
        expect(token() - before).toBe(1)
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe("save conflict guard", () => {
    const conflicted = async (deps: Partial<ProjectEditorDeps>) => {
      let fire: ((c: WorkspaceFsChange) => void) | null = null
      const d = makeDeps({
        ...deps,
        watch: jest.fn((_root, cb) => {
          fire = cb
          return () => {}
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps: d })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "local draft"))
      act(() => fire?.({ kind: "modify", path: "/repo/src/a.ts" }))
      expect(result.current.openFiles[0]?.externallyChanged).toBe(true)
      return { result, deps: d }
    }

    it("refuses to overwrite an external change until confirmed", async () => {
      const { result, deps } = await conflicted({})
      const confirm = jest.spyOn(window, "confirm").mockReturnValue(false)
      try {
        await act(async () => {
          await result.current.saveFile("src/a.ts")
        })
        expect(confirm).toHaveBeenCalled()
        expect(deps.writeFile).not.toHaveBeenCalledWith("/repo", "src/a.ts", "local draft")

        confirm.mockReturnValue(true)
        await act(async () => {
          await result.current.saveFile("src/a.ts")
        })
        expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "local draft")
      } finally {
        confirm.mockRestore()
      }
    })

    it("force saves without confirming (bridge flush / explicit overwrite)", async () => {
      const { result, deps } = await conflicted({})
      const confirm = jest.spyOn(window, "confirm")
      try {
        await act(async () => {
          await result.current.saveFile("src/a.ts", { force: true })
        })
        expect(confirm).not.toHaveBeenCalled()
        expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "local draft")
        expect(result.current.openFiles[0]?.externallyChanged).toBe(false)
      } finally {
        confirm.mockRestore()
      }
    })

    it("saving a deletedOnDisk buffer restores it", async () => {
      let fire: ((c: WorkspaceFsChange) => void) | null = null
      const deps = makeDeps({
        watch: jest.fn((_root, cb) => {
          fire = cb
          return () => {}
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "last surviving draft"))
      act(() => fire?.({ kind: "delete", path: "/repo/src/a.ts" }))
      expect(result.current.openFiles[0]?.deletedOnDisk).toBe(true)

      await act(async () => {
        await result.current.saveFile("src/a.ts", { force: true })
      })
      expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "last surviving draft")
      expect(result.current.openFiles[0]?.deletedOnDisk).toBe(false)
    })
  })

  describe("reconcileDeleted", () => {
    it("closes clean tabs under a deleted path and keeps dirty ones flagged", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      act(() => result.current.setDraft("src/b.ts", "unsaved"))

      act(() => result.current.reconcileDeleted(["src"]))
      // Clean tab closed outright; dirty one stays as the last copy.
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts"])
      expect(result.current.openFiles[0]?.deletedOnDisk).toBe(true)
      expect(result.current.activePath).toBe("src/b.ts")
    })

    it("falls back to a neighbour when the active tab is deleted clean", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      expect(result.current.activePath).toBe("src/b.ts")

      act(() => result.current.reconcileDeleted(["src/b.ts"]))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
      expect(result.current.activePath).toBe("src/a.ts")
      expect(getModelRetainCount("file:///repo/src/b.ts")).toBe(0)
    })
  })

  it("persists the session only when the persisted fields change", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await waitFor(() => expect(deps.listWorktrees).toHaveBeenCalled())
    await act(async () => {
      await result.current.openFile("src/a.ts")
    })
    const callsAfterOpen = setEditorSession.mock.calls.length
    // A keystroke changes openFiles identity but not rootKey/openPaths/activePath.
    act(() => result.current.setDraft("src/a.ts", "draft"))
    act(() => result.current.setDraft("src/a.ts", "draft again"))
    expect(setEditorSession.mock.calls.length).toBe(callsAfterOpen)
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
      // Fast A→B clicking: A's stat is still settling when B claims the
      // single preview slot and evicts A — the evicted tab never even reaches
      // its `readFile`, and nothing appends A back into the one-slot dock.
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
      const flush = () => new Promise((r) => setTimeout(r, 0))

      await act(async () => {
        // `openFile` resolves the tab transition off refs before it awaits, so
        // both calls interleave exactly as two fast clicks would. `readFile`
        // now only fires once `statFile` has settled, so the queue has to
        // drain before B's read exists.
        result.current.openFile("src/a.ts", { mode: "preview" })
        result.current.openFile("src/b.ts", { mode: "preview" })
        await flush()
        gate["src/b.ts"]?.("export const b = 2\n")
        await flush()
      })

      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts"])
      expect(result.current.previewPath).toBe("src/b.ts")
      expect(result.current.activePath).toBe("src/b.ts")
      // The evicted preview's read was skipped entirely and its model hold is
      // gone — not just withheld from the tab list.
      expect(
        (deps.readFile as jest.Mock).mock.calls.filter((c) => c[1] === "src/a.ts")
      ).toHaveLength(0)
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
      const flush = () => new Promise((r) => setTimeout(r, 0))

      await act(async () => {
        const staleA = result.current.openFile("src/a.ts", { mode: "preview" })
        // statFile resolves before readFile is invoked — drain the queue so
        // the stale read actually exists before capturing its rejecter.
        await flush()
        const failStaleA = gate["src/a.ts"]!.fail
        const openB = result.current.openFile("src/b.ts", { mode: "preview" })
        await flush()
        pending.find((p) => p.rel === "src/b.ts")?.resolve("export const b = 2\n")
        await openB
        await flush()

        // A comes back, starting a second read that will succeed.
        const freshA = result.current.openFile("src/a.ts", { mode: "preview" })
        await flush()
        failStaleA(new Error("disk went away"))
        await staleA
        pending.at(-1)?.resolve("export const a = 1\n")
        await freshA
        await flush()
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

  describe("blocked files", () => {
    it("opens a binary extension as a placeholder without a text read", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("assets/logo.png"))
      const file = result.current.openFiles.find((f) => f.relPath === "assets/logo.png")
      expect(file).toMatchObject({ blocked: "binary", savedContent: "", draftContent: "" })
      expect(
        (deps.readFile as jest.Mock).mock.calls.filter((c) => c[1] === "assets/logo.png")
      ).toHaveLength(0)
    })

    it("marks a file binary when the text read fails UTF-8 decoding", async () => {
      const deps = makeDeps({
        readFile: jest.fn(async (_root: string, rel: string) => {
          if (rel === "blob.bin.dat") return ""
          throw new Error("stream did not contain valid UTF-8")
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/odd.ts"))
      expect(result.current.openFiles.find((f) => f.relPath === "src/odd.ts")).toMatchObject({
        blocked: "binary",
        savedContent: "",
      })
    })

    it("blocks files over the editor byte ceiling as too-large", async () => {
      const deps = makeDeps({
        statFile: jest.fn(async () => ({
          exists: true,
          isDir: false,
          size: MAX_EDITOR_BYTES + 1,
          mtimeMs: 1234,
        })),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      expect(result.current.activeFile).toMatchObject({
        blocked: "too-large",
        savedContent: "",
        sizeBytes: MAX_EDITOR_BYTES + 1,
      })
      // Stat answers before any read: an oversized file never sends its first
      // chunk through IPC just to be thrown away.
      expect(deps.readFile).not.toHaveBeenCalled()
    })

    it("stats before it reads, so the size verdict precedes the transfer", async () => {
      const order: string[] = []
      const deps = makeDeps({
        statFile: jest.fn(async () => {
          order.push("stat")
          return { exists: true, isDir: false, size: 10, mtimeMs: 1234 }
        }),
        readFile: jest.fn(async () => {
          order.push("read")
          return "export const a = 1\n"
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      expect(order).toEqual(["stat", "read"])
    })

    it("falls back to the capped read when stat cannot answer", async () => {
      const deps = makeDeps({
        statFile: jest.fn(async () => {
          throw new Error("stat unsupported")
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      expect(deps.readFile).toHaveBeenCalledWith("/repo", "src/a.ts", MAX_EDITOR_BYTES + 1)
      expect(result.current.activeFile?.blocked).toBeUndefined()
    })

    it("opens a Jest .snap snapshot as text, not a binary placeholder", async () => {
      const deps = makeDeps({
        readFile: jest.fn(async (_root: string, rel: string) =>
          rel.endsWith(".snap") ? "exports[`renders 1`] = `<div/>`\n" : ""
        ),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("__snapshots__/a.test.tsx.snap"))
      expect(result.current.activeFile).toMatchObject({
        blocked: undefined,
        savedContent: "exports[`renders 1`] = `<div/>`\n",
      })
    })

    it("saveFile never writes a blocked tab's empty buffer over the file", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("assets/logo.png"))
      expect(result.current.activeFile?.blocked).toBe("binary")
      await act(async () => result.current.saveFile("assets/logo.png"))
      await act(async () => result.current.saveAll())
      expect(deps.writeFile).not.toHaveBeenCalled()
    })

    it("open anyway re-reads a too-large file without the cap and unblocks it", async () => {
      const deps = makeDeps({
        statFile: jest.fn(async () => ({
          exists: true,
          isDir: false,
          size: MAX_EDITOR_BYTES + 1,
          mtimeMs: 1234,
        })),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      expect(result.current.activeFile?.blocked).toBe("too-large")

      // The forced read bypasses the ceiling: no maxBytes argument.
      await act(async () => result.current.openFile("src/a.ts", { allowLarge: true }))
      const forced = (deps.readFile as jest.Mock).mock.calls.at(-1)
      expect(forced?.[1]).toBe("src/a.ts")
      expect(forced?.[2]).toBeUndefined()
      expect(result.current.activeFile).toMatchObject({
        blocked: undefined,
        savedContent: "export const a = 1\n",
      })
    })

    it("does not force-read an already-open file that is not too-large", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      const before = (deps.readFile as jest.Mock).mock.calls.length
      await act(async () => result.current.openFile("src/a.ts", { allowLarge: true }))
      expect((deps.readFile as jest.Mock).mock.calls.length).toBe(before)
    })

    it("clears a binary block when a rename lands on a text extension", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("img.png"))
      expect(result.current.activeFile?.blocked).toBe("binary")
      await act(() => result.current.renameOpenFile("img.png", "img.txt"))
      expect(result.current.activeFile?.blocked).toBeUndefined()
    })

    it("keeps a binary block when the rename stays binary", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("img.png"))
      await act(() => result.current.renameOpenFile("img.png", "img.webp"))
      expect(result.current.activeFile?.blocked).toBe("binary")
    })

    it("re-classifies on reload: a file that turned binary stays out of drafts", async () => {
      let utf8 = false
      const deps = makeDeps({
        readFile: jest.fn(async (_root: string, rel: string) => {
          if (utf8) throw new Error("stream did not contain valid UTF-8")
          return `// ${rel}\n`
        }),
      })
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      expect(result.current.activeFile?.blocked).toBeUndefined()

      utf8 = true
      await act(async () => result.current.reloadFile("src/a.ts"))
      expect(result.current.activeFile).toMatchObject({ blocked: "binary", savedContent: "" })
    })
  })

  describe("tab batch operations", () => {
    const open3 = async (
      result: { current: ReturnType<typeof useProjectEditor> },
      deps: Partial<ProjectEditorDeps>
    ) => {
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
        await result.current.openFile("src/c.ts")
      })
      expect(deps.readFile).toHaveBeenCalledTimes(3)
    }

    it("moveOpenFile reorders tabs", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      act(() => result.current.moveOpenFile("src/c.ts", "src/a.ts"))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual([
        "src/c.ts",
        "src/a.ts",
        "src/b.ts",
      ])
    })

    it("moveOpenFile ignores unknown or identical paths", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      const before = result.current.openFiles.map((f) => f.relPath)
      act(() => {
        result.current.moveOpenFile("src/missing.ts", "src/a.ts")
        result.current.moveOpenFile("src/a.ts", "src/a.ts")
      })
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(before)
    })

    it("closeFiles closes exactly the named set and moves the active marker to a survivor", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      // Active is c.ts; closing it (with a.ts) must hand the selection to the
      // only survivor rather than leaving it dangling.
      act(() => result.current.closeFiles(new Set(["src/a.ts", "src/c.ts"])))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts"])
      expect(result.current.activePath).toBe("src/b.ts")
    })

    it("closeFiles keeps the active tab when it is not in the closing set", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      act(() => result.current.closeFiles(new Set(["src/a.ts"])))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts", "src/c.ts"])
      expect(result.current.activePath).toBe("src/c.ts")
    })

    it("closeFiles ignores an empty set", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      act(() => result.current.closeFiles(new Set()))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ])
      expect(result.current.activePath).toBe("src/c.ts")
    })

    it("closeAllFiles empties the editor and clears the selection", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await open3(result, deps)
      act(() => result.current.closeAllFiles())
      expect(result.current.openFiles).toEqual([])
      expect(result.current.activePath).toBeNull()
      expect(getRetainedModelUris()).toEqual([])
    })
  })

  describe("dirty close confirmation", () => {
    let confirmSpy: jest.SpyInstance
    beforeEach(() => {
      confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false)
    })
    afterEach(() => {
      confirmSpy.mockRestore()
    })

    it("keeps a dirty tab when the user cancels the close", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      act(() => result.current.closeFile("src/a.ts"))
      expect(confirmSpy).toHaveBeenCalled()
      // A cancelled close must be a full no-op: tab, draft and model hold stay.
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
      expect(result.current.openFiles[0].draftContent).toBe("unsaved\n")
      expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)
    })

    it("closes a dirty tab once the user confirms", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      confirmSpy.mockReturnValue(true)
      act(() => result.current.closeFile("src/a.ts"))
      expect(result.current.openFiles).toEqual([])
      expect(result.current.activePath).toBeNull()
    })

    it("never asks when nothing in scope is dirty", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      act(() => result.current.closeAllFiles())
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(result.current.openFiles).toEqual([])
    })

    it("a cancelled batch close drops no tabs at all", async () => {
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      act(() => result.current.setDraft("src/b.ts", "unsaved\n"))

      // Only b.ts is dirty, but the batch is all-or-nothing: a cancel keeps
      // even the clean tab in scope.
      act(() => result.current.closeAllFiles())
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
    })

    it("an injected async confirm defers the close until it resolves", async () => {
      let answer!: () => void
      const confirm = jest.fn(
        (request: { message: string; confirmLabel: string }) =>
          new Promise<boolean>((resolve) => {
            answer = () => resolve(request.confirmLabel === "Don't Save")
          })
      )
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps, confirm })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      act(() => result.current.closeFile("src/a.ts"))
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Don't Save" }))
      // Pending verdict: the tab and its draft must still be there.
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])

      // "Don't Save" maps to an affirmative answer → the close lands.
      await act(async () => answer())
      expect(result.current.openFiles).toEqual([])
    })

    it("an injected async confirm resolved false keeps the tab", async () => {
      let answer!: (ok: boolean) => void
      const confirm = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps, confirm })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      act(() => result.current.closeFile("src/a.ts"))
      await act(async () => answer(false))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
      expect(result.current.openFiles[0].draftContent).toBe("unsaved\n")
    })

    it("a deferred close re-reads the live open set, not the stale one", async () => {
      let answer!: (ok: boolean) => void
      const confirm = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      const deps = makeDeps()
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps, confirm })
      )
      await act(async () => {
        await result.current.openFile("src/a.ts")
        await result.current.openFile("src/b.ts")
      })
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      // Start a dirty close on a.ts, then open a third tab while the dialog
      // is up — the deferred close must not resurrect or drop it.
      act(() => result.current.closeFile("src/a.ts"))
      await act(async () => result.current.openFile("src/c.ts"))
      await act(async () => answer(true))
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/b.ts", "src/c.ts"])
    })

    it("a 'save' verdict writes the draft, then closes the tab", async () => {
      const deps = makeDeps()
      const confirm = jest.fn(() => Promise.resolve("save" as const))
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps, confirm })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      act(() => result.current.closeFile("src/a.ts"))
      // Let the deferred save land before asserting the close.
      await act(async () => {})
      expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/a.ts", "unsaved\n")
      expect(result.current.openFiles).toEqual([])
    })

    it("a 'save' verdict keeps the tab when the write fails", async () => {
      const deps = makeDeps({ writeFile: jest.fn().mockRejectedValue(new Error("EIO")) })
      const confirm = jest.fn(() => Promise.resolve("save" as const))
      const { result } = renderHook(() =>
        useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps, confirm })
      )
      await act(async () => result.current.openFile("src/a.ts"))
      act(() => result.current.setDraft("src/a.ts", "unsaved\n"))

      act(() => result.current.closeFile("src/a.ts"))
      await act(async () => {})
      expect(result.current.openFiles.map((f) => f.relPath)).toEqual(["src/a.ts"])
      expect(result.current.openFiles[0].draftContent).toBe("unsaved\n")
    })
  })

  it("records monaco language and size metadata on open", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useProjectEditor({ scopeKey: "team:team1", workingDir: "/repo", deps })
    )
    await act(async () => result.current.openFile("src/a.ts"))
    expect(result.current.activeFile).toMatchObject({
      language: "typescript",
      monacoLanguage: "typescript",
      sizeBytes: 10,
      blocked: undefined,
    })
  })
})
