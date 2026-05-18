import {
  __resetLspWorkspaceManagerForTesting,
  configureLspWorkspaceManager,
  disposeAllWorkspaces,
  disposeWorkspace,
  ensureWorkspace,
  FLUSH_DEBOUNCE_MS,
  flushDocument,
  listWorkspaceFolders,
  resolveWorkspaceFolder,
  type LspWorkspaceFsAdapter,
} from "./lsp-workspace-manager"

/**
 * In-memory fs adapter — records every operation in arrays so tests can
 * assert exact behaviour. `mkdir` and `remove` track absolute paths;
 * `writeFile` keeps the most recent content per path.
 */
function makeFakeFs(opts: { appDataDir?: string } = {}): LspWorkspaceFsAdapter & {
  files: Map<string, string>
  dirs: Set<string>
  writeCalls: Array<{ path: string; content: string }>
  removeCalls: string[]
} {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writeCalls: Array<{ path: string; content: string }> = []
  const removeCalls: string[] = []
  return {
    files,
    dirs,
    writeCalls,
    removeCalls,
    async appDataDir() {
      return opts.appDataDir ?? "/home/user/AppData/Roaming"
    },
    async createDir(path) {
      dirs.add(path)
    },
    async writeFile(path, content) {
      files.set(path, content)
      writeCalls.push({ path, content })
    },
    async removeDir(path) {
      dirs.delete(path)
      removeCalls.push(path)
      // Also evict any files under this path so disposal is truly clean.
      for (const k of [...files.keys()]) {
        if (k.startsWith(path + "/")) files.delete(k)
      }
    },
    joinPath(...segments) {
      return segments
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/\\/g, "/").replace(/\/+$/g, ""))
        .join("/")
    },
    pathToFileUri(p) {
      const norm = p.replace(/\\/g, "/")
      return /^[a-zA-Z]:/.test(norm)
        ? `file:///${norm}`
        : norm.startsWith("/")
          ? `file://${norm}`
          : `file:///${norm}`
    },
  }
}

beforeEach(() => {
  __resetLspWorkspaceManagerForTesting()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("lsp-workspace-manager", () => {
  describe("configuration", () => {
    it("throws when any op runs before configureLspWorkspaceManager", async () => {
      await expect(
        ensureWorkspace({
          surface: "skill",
          documentId: "d",
          fileName: "x.ts",
          initialContent: "",
          monacoUri: "skill:///s/d.ts",
        })
      ).rejects.toThrow(/configureLspWorkspaceManager must be called/)
    })
  })

  describe("ensureWorkspace", () => {
    it("creates the directory tree and writes the initial file", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)

      const path = await ensureWorkspace({
        surface: "skill",
        documentId: "doc-1",
        fileName: "main.ts",
        initialContent: "const x = 1",
        monacoUri: "skill:///s/doc-1.ts",
      })

      expect(path).toBe("/home/user/AppData/Roaming/cognia/lsp-workspaces/skill-doc-1")
      expect(fs.dirs.has(path)).toBe(true)
      expect(fs.files.get(path + "/main.ts")).toBe("const x = 1")
    })

    it("is idempotent — second call returns the same path and skips re-creation", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)

      const a = await ensureWorkspace({
        surface: "canvas",
        documentId: "art",
        fileName: "doc.ts",
        initialContent: "v1",
        monacoUri: "canvas:///default/art.ts",
      })
      const b = await ensureWorkspace({
        surface: "canvas",
        documentId: "art",
        fileName: "doc.ts",
        initialContent: "v2-ignored",
        monacoUri: "canvas:///default/art.ts",
      })
      expect(a).toBe(b)
      // Initial content from the first call is preserved on disk.
      expect(fs.files.get(a + "/doc.ts")).toBe("v1")
      // Only one writeFile call.
      expect(fs.writeCalls).toHaveLength(1)
    })

    it("isolates workspaces by surface + documentId", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)

      const p1 = await ensureWorkspace({
        surface: "skill",
        documentId: "doc",
        fileName: "x.ts",
        initialContent: "",
        monacoUri: "skill:///s/doc.ts",
      })
      const p2 = await ensureWorkspace({
        surface: "canvas",
        documentId: "doc",
        fileName: "x.ts",
        initialContent: "",
        monacoUri: "canvas:///default/doc.ts",
      })
      expect(p1).not.toBe(p2)
      expect(fs.dirs.size).toBe(2)
    })
  })

  describe("flushDocument", () => {
    it("coalesces rapid writes into one fs call after the debounce window", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)

      await ensureWorkspace({
        surface: "skill",
        documentId: "d",
        fileName: "x.ts",
        initialContent: "",
        monacoUri: "skill:///s/d.ts",
      })
      const writesBefore = fs.writeCalls.length

      const p1 = flushDocument({ surface: "skill", documentId: "d" }, "v1")
      const p2 = flushDocument({ surface: "skill", documentId: "d" }, "v2")
      const p3 = flushDocument({ surface: "skill", documentId: "d" }, "v3")

      // Nothing should fire before FLUSH_DEBOUNCE_MS elapses.
      jest.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1)
      expect(fs.writeCalls.length).toBe(writesBefore)

      jest.advanceTimersByTime(2)
      await Promise.all([p1, p2, p3])
      // Exactly one extra write — the final coalesced content.
      expect(fs.writeCalls.length).toBe(writesBefore + 1)
      expect(fs.writeCalls.at(-1)?.content).toBe("v3")
    })

    it("rejects when no workspace exists for the spec", async () => {
      configureLspWorkspaceManager(makeFakeFs())
      await expect(
        flushDocument({ surface: "skill", documentId: "missing" }, "boom")
      ).rejects.toThrow(/unknown workspace/i)
    })

    it("rejects the promise when writeFile fails", async () => {
      const fs = makeFakeFs()
      let attempt = 0
      fs.writeFile = async (path, content) => {
        attempt += 1
        if (attempt > 1) throw new Error("disk full")
        fs.files.set(path, content)
        fs.writeCalls.push({ path, content })
      }
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "d",
        fileName: "x.ts",
        initialContent: "",
        monacoUri: "skill:///s/d.ts",
      })
      const flushPromise = flushDocument({ surface: "skill", documentId: "d" }, "v")
      jest.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 1)
      await expect(flushPromise).rejects.toThrow(/disk full/)
    })
  })

  describe("resolveWorkspaceFolder & listWorkspaceFolders", () => {
    it("resolves the workspace folder for a known Monaco URI", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "s1",
        fileName: "main.ts",
        initialContent: "",
        monacoUri: "skill:///A/s1.ts",
      })
      const folder = resolveWorkspaceFolder("skill:///A/s1.ts")
      expect(folder).toEqual({
        uri: "file:///home/user/AppData/Roaming/cognia/lsp-workspaces/skill-s1",
        name: "skill-s1",
      })
    })

    it("returns null for unknown Monaco URIs", async () => {
      configureLspWorkspaceManager(makeFakeFs())
      expect(resolveWorkspaceFolder("skill:///nope.ts")).toBeNull()
    })

    it("listWorkspaceFolders enumerates every active workspace", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "a",
        fileName: "a.ts",
        initialContent: "",
        monacoUri: "skill:///A/a.ts",
      })
      await ensureWorkspace({
        surface: "canvas",
        documentId: "b",
        fileName: "b.ts",
        initialContent: "",
        monacoUri: "canvas:///default/b.ts",
      })
      const folders = listWorkspaceFolders()
      expect(folders).toHaveLength(2)
      expect(folders.map((f) => f.name).sort()).toEqual(["canvas-b", "skill-a"])
    })
  })

  describe("disposeWorkspace", () => {
    it("removes the directory and clears caches", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "d",
        fileName: "x.ts",
        initialContent: "v",
        monacoUri: "skill:///s/d.ts",
      })
      await disposeWorkspace({ surface: "skill", documentId: "d" })
      expect(resolveWorkspaceFolder("skill:///s/d.ts")).toBeNull()
      expect(fs.removeCalls).toHaveLength(1)
    })

    it("drains a pending flush before removing the directory", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "d",
        fileName: "x.ts",
        initialContent: "v1",
        monacoUri: "skill:///s/d.ts",
      })
      const writesBefore = fs.writeCalls.length

      void flushDocument({ surface: "skill", documentId: "d" }, "v-final")
      // Dispose BEFORE the debounce timer fires.
      await disposeWorkspace({ surface: "skill", documentId: "d" })

      // The pending content was written synchronously as part of dispose,
      // and the dir was removed afterwards.
      expect(fs.writeCalls.length).toBe(writesBefore + 1)
      expect(fs.writeCalls.at(-1)?.content).toBe("v-final")
      expect(fs.removeCalls).toHaveLength(1)
    })

    it("is idempotent on a missing workspace (no throw)", async () => {
      configureLspWorkspaceManager(makeFakeFs())
      await expect(
        disposeWorkspace({ surface: "skill", documentId: "ghost" })
      ).resolves.toBeUndefined()
    })

    it("warns + continues when removeDir throws", async () => {
      const fs = makeFakeFs()
      fs.removeDir = async () => {
        throw new Error("locked")
      }
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "d",
        fileName: "x.ts",
        initialContent: "",
        monacoUri: "skill:///s/d.ts",
      })
      // Should not throw despite the fs error.
      await expect(disposeWorkspace({ surface: "skill", documentId: "d" })).resolves.toBeUndefined()
    })
  })

  describe("disposeAllWorkspaces", () => {
    it("tears down every allocated workspace", async () => {
      const fs = makeFakeFs()
      configureLspWorkspaceManager(fs)
      await ensureWorkspace({
        surface: "skill",
        documentId: "a",
        fileName: "a.ts",
        initialContent: "",
        monacoUri: "skill:///A/a.ts",
      })
      await ensureWorkspace({
        surface: "canvas",
        documentId: "b",
        fileName: "b.ts",
        initialContent: "",
        monacoUri: "canvas:///default/b.ts",
      })
      await disposeAllWorkspaces()
      expect(listWorkspaceFolders()).toEqual([])
    })
  })
})
