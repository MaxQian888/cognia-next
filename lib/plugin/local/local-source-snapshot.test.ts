import { collectLocalPluginSource, type LocalSourceFs } from "./local-source-snapshot"

/** In-memory tree: absolute path to contents. Directories are implicit. */
function fakeFs(tree: Record<string, string>): LocalSourceFs {
  const dirs = new Set<string>()
  for (const path of Object.keys(tree)) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"))
  }
  return {
    async readDir(path) {
      if (!dirs.has(path)) throw new Error(`ENOENT ${path}`)
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const candidate of [...Object.keys(tree), ...dirs]) {
        if (!candidate.startsWith(prefix)) continue
        names.add(candidate.slice(prefix.length).split("/")[0])
      }
      return [...names]
    },
    async stat(path) {
      if (path in tree) return { size: tree[path].length, isFile: true }
      if (dirs.has(path)) return { size: 0, isFile: false }
      throw new Error(`ENOENT ${path}`)
    },
    async readTextFile(path) {
      if (!(path in tree)) throw new Error(`ENOENT ${path}`)
      return tree[path]
    },
  }
}

describe("collectLocalPluginSource", () => {
  it("reads text files and placeholds binaries", async () => {
    const snapshot = await collectLocalPluginSource(
      "/p",
      fakeFs({
        "/p/.claude-plugin/plugin.json": '{"name":"x"}',
        "/p/skills/a/SKILL.md": "# a",
        "/p/skills/a/logo.png": "PNGDATA",
      })
    )
    expect(snapshot.files.get(".claude-plugin/plugin.json")).toBe('{"name":"x"}')
    expect(snapshot.files.get("skills/a/SKILL.md")).toBe("# a")
    // Kept as a path so a resource-bearing skill stays a bundle.
    expect(snapshot.files.get("skills/a/logo.png")).toBe("")
    expect(snapshot.binaryPaths.has("skills/a/logo.png")).toBe(true)
  })

  it("uses paths relative to the picked directory", async () => {
    const snapshot = await collectLocalPluginSource(
      "/deeply/nested/p",
      fakeFs({ "/deeply/nested/p/plugin.json": "{}" })
    )
    expect([...snapshot.files.keys()]).toEqual(["plugin.json"])
  })

  it("skips node_modules and .git rather than refusing the whole source", async () => {
    // Pointing this at a repo checkout is a plausible mistake, and node_modules
    // alone exceeds the entry cap before the walk reaches anything useful.
    const tree: Record<string, string> = { "/p/plugin.json": "{}" }
    for (let i = 0; i < 50; i += 1) tree[`/p/node_modules/pkg-${i}/index.js`] = "x"
    tree["/p/.git/config"] = "x"
    const snapshot = await collectLocalPluginSource("/p", fakeFs(tree))
    expect([...snapshot.files.keys()]).toEqual(["plugin.json"])
  })

  it("refuses a source with too many files instead of truncating it", async () => {
    // A partial snapshot converts to a partial plugin, and the report would
    // claim everything carried over.
    const tree: Record<string, string> = {}
    for (let i = 0; i < 2_100; i += 1) tree[`/p/skills/s${i}.md`] = "x"
    await expect(collectLocalPluginSource("/p", fakeFs(tree))).rejects.toThrow(/more than 2000/)
  })

  it("refuses an oversized text file", async () => {
    await expect(
      collectLocalPluginSource("/p", fakeFs({ "/p/big.md": "x".repeat(1_000_001) }))
    ).rejects.toThrow(/too large to convert safely/)
  })

  it("skips an unreadable subdirectory but keeps the rest", async () => {
    const fs = fakeFs({ "/p/plugin.json": "{}", "/p/skills/a.md": "# a" })
    const guarded: LocalSourceFs = {
      ...fs,
      readDir: async (path) => {
        if (path === "/p/skills") throw new Error("EACCES")
        return fs.readDir(path)
      },
    }
    const snapshot = await collectLocalPluginSource("/p", guarded)
    expect([...snapshot.files.keys()]).toEqual(["plugin.json"])
  })

  it("returns an empty snapshot for an unreadable root rather than throwing", async () => {
    // The caller distinguishes "unreadable" from "not a plugin". This layer
    // only reports what it could see.
    const snapshot = await collectLocalPluginSource("/nope", fakeFs({}))
    expect(snapshot.files.size).toBe(0)
  })
})
