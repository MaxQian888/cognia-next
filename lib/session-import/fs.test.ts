import { realSessionFs, walkFiles } from "./fs"
import type { SessionFs } from "./types"

/** In-memory fs over a { path: contents | null(dir) } map. */
function fakeFs(tree: Record<string, string | null>): SessionFs {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  return {
    async exists(p) {
      return norm(p) in tree
    },
    async readDir(p) {
      const base = norm(p)
      const children = new Set<string>()
      for (const key of Object.keys(tree)) {
        const k = norm(key)
        if (k.startsWith(base + "/")) {
          const rest = k.slice(base.length + 1)
          const name = rest.split("/")[0]
          if (name) children.add(name)
        }
      }
      return [...children]
    },
    async stat(p) {
      const v = tree[norm(p)]
      if (v === undefined) throw new Error("ENOENT")
      return { size: v ? v.length : 0, isFile: v !== null }
    },
    async readTextFile(p) {
      const v = tree[norm(p)]
      if (!v) throw new Error("ENOENT")
      return v
    },
  }
}

describe("walkFiles", () => {
  it("recursively collects files matching the predicate", async () => {
    const fs = fakeFs({
      "/root": null,
      "/root/2025": null,
      "/root/2025/01": null,
      "/root/2025/01/a.jsonl": "x",
      "/root/2025/01/note.txt": "y",
      "/root/b.jsonl": "z",
    })
    const found = await walkFiles(fs, "/root", (n) => n.endsWith(".jsonl"))
    expect(found.sort()).toEqual(["/root/2025/01/a.jsonl", "/root/b.jsonl"])
  })

  it("returns [] for an unreadable directory", async () => {
    const fs = fakeFs({})
    expect(await walkFiles(fs, "/missing", () => true)).toEqual([])
  })

  it("stops descending instead of following a symlink loop forever", async () => {
    // A `~/.claude -> ~` style loop inside a watched agent directory would
    // otherwise recurse until the scan blew the stack, on a path the user
    // cannot see and did not choose.
    let deepest = 0
    const loopingFs = {
      exists: async () => true,
      readDir: async (dir: string) => {
        deepest = Math.max(deepest, dir.split("/").length)
        return ["loop"]
      },
      stat: async () => ({ size: 0, isFile: false }),
      readTextFile: async () => "",
    }
    await expect(walkFiles(loopingFs, "/root", () => true)).resolves.toEqual([])
    // Bounded, and generously above the deepest real layout (Codex's
    // `sessions/YYYY/MM/DD`).
    expect(deepest).toBeLessThan(20)
  })
})

jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/file/file-operations", () => ({
  exists: jest.fn(async () => false),
  readDir: jest.fn(async () => []),
  readDirEntries: jest.fn(async () => []),
  statFile: jest.fn(async () => ({ size: 0, isFile: false })),
  readTextFile: jest.fn(async () => "web fixture"),
}))

describe("realSessionFs native history access", () => {
  const { invoke } = jest.requireMock("@tauri-apps/api/core")
  const { isTauri } = jest.requireMock("@/lib/platform/detect")
  const generalFs = jest.requireMock("@/lib/file/file-operations")

  beforeEach(() => {
    jest.clearAllMocks()
    isTauri.mockReturnValue(true)
  })

  it("reads complete native history through the confined read-only command", async () => {
    const content = "x".repeat(1024 * 1024)
    invoke.mockResolvedValue({ kind: "text", content })
    await expect(realSessionFs().readTextFile("/home/.codex/sessions/a.jsonl")).resolves.toBe(
      content
    )
    expect(invoke).toHaveBeenCalledWith("session_import_fs", {
      operation: "readText",
      path: "/home/.codex/sessions/a.jsonl",
    })
    expect(generalFs.readTextFile).not.toHaveBeenCalled()
  })

  it("retains directory types and unknown symlink types without per-entry IPC", async () => {
    const entries = [
      { name: "a.jsonl", isFile: true },
      { name: "year", isFile: false },
      { name: "link" },
    ]
    invoke.mockResolvedValue({ kind: "directory", entries })
    const fs = realSessionFs()
    await expect(fs.readDirEntries!("/home/.codex/sessions")).resolves.toEqual(entries)
    await expect(fs.readDir("/home/.codex/sessions")).resolves.toEqual(["a.jsonl", "year", "link"])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(generalFs.readDirEntries).not.toHaveBeenCalled()
  })

  it("distinguishes absence from access errors without a permissive fallback", async () => {
    invoke.mockResolvedValue({ kind: "stat", exists: false, size: 0, isFile: false })
    const fs = realSessionFs()
    await expect(fs.exists("/home/.qwen/projects/missing")).resolves.toBe(false)
    await expect(fs.stat("/home/.qwen/projects/missing")).rejects.toThrow("does not exist")
    invoke.mockRejectedValue(new Error("outside approved history roots"))
    await expect(fs.exists("/private/secret.json")).rejects.toThrow("outside approved")
    await expect(fs.readTextFile("/private/secret.json")).rejects.toThrow("outside approved")
    expect(generalFs.exists).not.toHaveBeenCalled()
    expect(generalFs.readTextFile).not.toHaveBeenCalled()
  })

  it("maps native file metadata and rejects mismatched response kinds", async () => {
    invoke.mockResolvedValue({ kind: "stat", exists: true, size: 123, isFile: true })
    await expect(realSessionFs().stat("/home/.pi/sessions/a.jsonl")).resolves.toEqual({
      size: 123,
      isFile: true,
    })
    invoke.mockResolvedValue({ kind: "text", content: "wrong operation" })
    await expect(realSessionFs().readDir("/home/.pi/sessions")).rejects.toThrow("Unexpected")
  })

  it("preserves the web fallback without invoking native commands", async () => {
    isTauri.mockReturnValue(false)
    const fs = realSessionFs()
    await expect(fs.readDir("/anything")).resolves.toEqual([])
    await expect(fs.readTextFile("/fixture.json")).resolves.toBe("web fixture")
    expect(invoke).not.toHaveBeenCalled()
  })
})
