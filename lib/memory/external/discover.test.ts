import { discoverExternalMemory } from "./discover"
import type { DiscoverCtx, ExternalFs } from "./types"

function makeFs(files: Record<string, number>, dirs: Record<string, string[]> = {}): ExternalFs {
  return {
    async exists(p) {
      return p in files || p in dirs
    },
    async readDir(p) {
      if (!(p in dirs)) throw new Error(`ENOENT: ${p}`)
      return dirs[p]
    },
    async stat(p) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return { size: files[p], isFile: true }
    },
  }
}

function ctx(over: Partial<DiscoverCtx> & { fs: ExternalFs }): DiscoverCtx {
  return { home: "/Users/x", roots: [], cwd: undefined, platform: "macos", ...over }
}

describe("discoverExternalMemory", () => {
  it("merges both agents and orders claude-code before codex", async () => {
    const fs = makeFs({
      "/Users/x/.claude/CLAUDE.md": 1,
      "/Users/x/.codex/AGENTS.md": 2,
    })
    const files = await discoverExternalMemory(ctx({ fs }))
    const agents = files.map((f) => f.agent)
    expect(agents.indexOf("claude-code")).toBeLessThan(agents.indexOf("codex"))
    expect(files.some((f) => f.agent === "claude-code")).toBe(true)
    expect(files.some((f) => f.agent === "codex")).toBe(true)
  })

  it("de-dupes by path key", async () => {
    const fs = makeFs({ "/Users/x/.claude/CLAUDE.md": 1, "/Users/x/.codex/AGENTS.md": 2 })
    const files = await discoverExternalMemory(ctx({ fs }))
    const ids = files.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("orders scopes within an agent (user before project)", async () => {
    const fs = makeFs({
      "/Users/x/.claude/CLAUDE.md": 1,
      "/proj/CLAUDE.md": 2,
    })
    const files = await discoverExternalMemory(ctx({ fs, roots: ["/proj"], cwd: "/proj" }))
    const claude = files.filter((f) => f.agent === "claude-code")
    expect(claude[0].scope).toBe("user")
    expect(claude.some((f) => f.scope === "project")).toBe(true)
  })
})
