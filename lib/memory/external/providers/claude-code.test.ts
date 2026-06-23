import { discoverClaudeCode } from "./claude-code"
import type { DiscoverCtx, ExternalFs } from "../types"

/** Minimal in-memory fs: `files` maps path→size, `dirs` maps dir→entry names. */
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

const HOME = "/Users/x"

function ctx(over: Partial<DiscoverCtx> & { fs: ExternalFs }): DiscoverCtx {
  return { home: HOME, roots: [], cwd: undefined, platform: "macos", ...over }
}

describe("discoverClaudeCode", () => {
  it("always surfaces the user-global slot, even when absent", async () => {
    const fs = makeFs({})
    const files = await discoverClaudeCode(ctx({ fs }))
    const user = files.find((f) => f.scope === "user")
    expect(user).toBeTruthy()
    expect(user?.absPath).toBe("/Users/x/.claude/CLAUDE.md")
    expect(user?.exists).toBe(false)
    expect(user?.editable).toBe(true)
  })

  it("reports size for an existing user file", async () => {
    const fs = makeFs({ "/Users/x/.claude/CLAUDE.md": 42 })
    const files = await discoverClaudeCode(ctx({ fs }))
    const user = files.find((f) => f.scope === "user")
    expect(user?.exists).toBe(true)
    expect(user?.bytes).toBe(42)
  })

  it("marks the managed policy file read-only and only when present", async () => {
    const present = makeFs({ "/Library/Application Support/ClaudeCode/CLAUDE.md": 10 })
    const files = await discoverClaudeCode(ctx({ fs: present }))
    const managed = files.find((f) => f.scope === "managed")
    expect(managed?.editable).toBe(false)

    const absent = makeFs({})
    const none = await discoverClaudeCode(ctx({ fs: absent }))
    expect(none.find((f) => f.scope === "managed")).toBeUndefined()
  })

  it("uses the linux managed path on linux", async () => {
    const fs = makeFs({ "/etc/claude-code/CLAUDE.md": 5 })
    const files = await discoverClaudeCode(ctx({ fs, platform: "linux" }))
    expect(files.find((f) => f.scope === "managed")?.absPath).toBe("/etc/claude-code/CLAUDE.md")
  })

  it("walks project files root→cwd and de-dupes", async () => {
    const fs = makeFs({
      "/proj/CLAUDE.md": 1,
      "/proj/.claude/CLAUDE.md": 2,
      "/proj/sub/CLAUDE.md": 3,
    })
    const files = await discoverClaudeCode(ctx({ fs, roots: ["/proj"], cwd: "/proj/sub" }))
    const project = files.filter((f) => f.scope === "project").map((f) => f.absPath)
    expect(project).toEqual(["/proj/CLAUDE.md", "/proj/.claude/CLAUDE.md", "/proj/sub/CLAUDE.md"])
  })

  it("discovers auto-memory and stars the active project", async () => {
    const projects = "/Users/x/.claude/projects"
    const enc = "-proj"
    const fs = makeFs(
      {
        [`${projects}/${enc}/memory/MEMORY.md`]: 7,
        [`${projects}/-other/memory/MEMORY.md`]: 8,
      },
      {
        [projects]: [enc, "-other"],
        [`${projects}/${enc}/memory`]: ["MEMORY.md"],
        [`${projects}/-other/memory`]: ["MEMORY.md"],
      }
    )
    const files = await discoverClaudeCode(ctx({ fs, roots: ["/proj"] }))
    const auto = files.filter((f) => f.scope === "auto")
    expect(auto).toHaveLength(2)
    expect(auto.find((f) => f.absPath.includes(`/${enc}/`))?.label).toContain("★")
    expect(auto.find((f) => f.absPath.includes("/-other/"))?.label).not.toContain("★")
  })

  it("tolerates a missing projects directory", async () => {
    const fs = makeFs({})
    const files = await discoverClaudeCode(ctx({ fs }))
    expect(files.some((f) => f.scope === "auto")).toBe(false)
  })

  it("leaves bytes undefined when stat fails on an existing file", async () => {
    const fs: ExternalFs = {
      async exists(p) {
        return p === "/Users/x/.claude/CLAUDE.md"
      },
      async readDir() {
        throw new Error("no")
      },
      async stat() {
        throw new Error("stat failed")
      },
    }
    const files = await discoverClaudeCode(ctx({ fs }))
    const user = files.find((f) => f.scope === "user")
    expect(user?.exists).toBe(true)
    expect(user?.bytes).toBeUndefined()
  })

  it("falls back to the root when the cwd is outside it", async () => {
    const fs = makeFs({ "/proj/CLAUDE.md": 1 })
    const files = await discoverClaudeCode(ctx({ fs, roots: ["/proj"], cwd: "/elsewhere" }))
    expect(files.find((f) => f.scope === "project")?.absPath).toBe("/proj/CLAUDE.md")
  })

  it("treats an existence-check error as absent", async () => {
    const fs: ExternalFs = {
      async exists() {
        throw new Error("EACCES")
      },
      async readDir() {
        throw new Error("no")
      },
      async stat() {
        throw new Error("no")
      },
    }
    const files = await discoverClaudeCode(ctx({ fs }))
    // The user slot is still surfaced (includeAbsent) but flagged not-existing.
    expect(files.find((f) => f.scope === "user")?.exists).toBe(false)
  })
})
