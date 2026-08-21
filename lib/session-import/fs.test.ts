import { walkFiles } from "./fs"
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
