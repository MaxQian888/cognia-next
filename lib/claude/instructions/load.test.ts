import { loadProjectInstructions, clearInstructionCache } from "./load"
import type { InstructionFs } from "./types"

function fakeFs(files: Record<string, string>): InstructionFs {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  return {
    async exists(p) {
      return map.has(norm(p))
    },
    async readDir(p) {
      const prefix = `${norm(p)}/`
      const names = new Set<string>()
      let any = false
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          any = true
          const rest = key.slice(prefix.length)
          if (!rest.includes("/")) names.add(rest)
        }
      }
      if (!any) throw new Error(`ENOENT ${p}`)
      return [...names]
    },
    async readText(p) {
      const v = map.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
  }
}

beforeEach(() => clearInstructionCache())

const base = { isTauriEnv: true as const, homeDir: null, now: () => 1000 }

describe("loadProjectInstructions", () => {
  it("returns empty when disabled", async () => {
    const r = await loadProjectInstructions({
      ...base,
      roots: ["/proj"],
      config: { enabled: false },
      fs: fakeFs({ "/proj/CLAUDE.md": "x" }),
    })
    expect(r).toEqual({ section: "", files: [], markdownAgentFiles: [], warnings: [] })
  })

  it("returns empty off-Tauri with no injected fs", async () => {
    const r = await loadProjectInstructions({ roots: ["/proj"], isTauriEnv: false })
    expect(r.section).toBe("")
  })

  it("loads, expands imports, and renders a section", async () => {
    const fs = fakeFs({
      "/proj/CLAUDE.md": "root rules @shared.md",
      "/proj/shared.md": "SHARED",
      "/proj/sub/AGENT.md": "sub rules",
    })
    const r = await loadProjectInstructions({
      ...base,
      cwd: "/proj/sub",
      roots: ["/proj"],
      config: { includeGlobal: false },
      fs,
    })
    expect(r.section).toContain("root rules SHARED")
    expect(r.section).toContain("sub rules")
    // shared.md was inlined, not emitted as its own block
    expect(r.section).not.toContain("## shared.md")
    expect(r.files.map((f) => f.label)).toEqual(["CLAUDE.md", "sub/AGENT.md"])
  })

  it("discovers .cognia/agents subagents when enabled", async () => {
    const fs = fakeFs({
      "/proj/.cognia/agents/reviewer.md": `---\ndescription: reviews\n---\nbody`,
    })
    const r = await loadProjectInstructions({
      ...base,
      cwd: "/proj",
      roots: ["/proj"],
      config: { includeGlobal: false },
      fs,
    })
    expect(r.markdownAgentFiles).toEqual([
      { id: "reviewer", content: `---\ndescription: reviews\n---\nbody` },
    ])
  })

  it("skips agent discovery when loadProjectAgents is false", async () => {
    const fs = fakeFs({ "/proj/.cognia/agents/reviewer.md": `---\ndescription: r\n---\nb` })
    const r = await loadProjectInstructions({
      ...base,
      cwd: "/proj",
      roots: ["/proj"],
      config: { includeGlobal: false, loadProjectAgents: false },
      fs,
    })
    expect(r.markdownAgentFiles).toEqual([])
  })

  it("warns on an unreadable discovered file", async () => {
    // exists() true but readText throws — simulate a race / permission error.
    const fs: InstructionFs = {
      async exists() {
        return true
      },
      async readDir() {
        throw new Error("nope")
      },
      async readText() {
        throw new Error("EACCES")
      },
    }
    const r = await loadProjectInstructions({
      ...base,
      cwd: "/proj",
      roots: ["/proj"],
      config: { includeGlobal: false },
      fs,
    })
    expect(r.warnings.some((w) => /could not read/.test(w))).toBe(true)
    expect(r.section).toBe("")
  })

  it("caches within the TTL and re-reads after it expires", async () => {
    let reads = 0
    const fs: InstructionFs = {
      async exists(p) {
        return p.endsWith("CLAUDE.md")
      },
      async readDir() {
        throw new Error("none")
      },
      async readText() {
        reads++
        return "rules"
      },
    }
    let t = 1000
    const input = {
      isTauriEnv: true as const,
      homeDir: null,
      cwd: "/proj",
      roots: ["/proj"],
      config: { includeGlobal: false, loadProjectAgents: false },
      fs,
      now: () => t,
    }
    await loadProjectInstructions(input)
    await loadProjectInstructions(input) // cached
    expect(reads).toBe(1)
    t += 5000 // past TTL
    await loadProjectInstructions(input)
    expect(reads).toBe(2)
  })

  it("uses an explicit global path verbatim", async () => {
    const fs = fakeFs({ "/custom/rules.md": "custom global" })
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: "/home",
      now: () => 1,
      roots: ["/proj"],
      config: { globalPath: "/custom/rules.md", loadProjectAgents: false },
      fs,
    })
    expect(r.files.map((f) => f.source)).toContain("global")
    expect(r.section).toContain("custom global")
  })

  it("loads no global when the home dir is unavailable", async () => {
    const fs = fakeFs({ "/proj/CLAUDE.md": "root" })
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: null,
      now: () => 1,
      cwd: "/proj",
      roots: ["/proj"],
      config: { loadProjectAgents: false }, // includeGlobal default true, but no home
      fs,
    })
    expect(r.files.map((f) => f.source)).toEqual(["project"])
  })

  it("falls back to empty home resolution when the tauri path API is absent", async () => {
    const fs = fakeFs({ "/proj/CLAUDE.md": "root" })
    // homeDir undefined → resolveHome attempts the @tauri-apps/api/path import,
    // which throws under jest → home resolves to undefined, discovery continues.
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      now: () => 1,
      cwd: "/proj",
      roots: ["/proj"],
      config: { loadProjectAgents: false },
      fs,
    })
    expect(r.section).toContain("root")
  })

  it("builds a real fs adapter when none is injected (off-Tauri → empty)", async () => {
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: null,
      now: () => 1,
      cwd: "/proj",
      roots: ["/proj"],
      config: { includeGlobal: false, loadProjectAgents: false },
    })
    expect(r.section).toBe("")
  })

  it("scans the filename precedence list for the global file", async () => {
    // Only CLAUDE.md exists under home → resolveGlobalPath loops past AGENTS/AGENT.
    const fs = fakeFs({ "/home/.cognia/CLAUDE.md": "global via claude" })
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: "/home",
      now: () => 1,
      roots: [],
      config: { loadProjectAgents: false },
      fs,
    })
    expect(r.section).toContain("global via claude")
  })

  it("survives a global exists() that throws", async () => {
    const fs: InstructionFs = {
      async exists(p) {
        if (p.includes(".cognia")) throw new Error("EACCES")
        return false
      },
      async readDir() {
        throw new Error("none")
      },
      async readText() {
        return ""
      },
    }
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: "/home",
      now: () => 1,
      cwd: "/proj",
      roots: ["/proj"],
      config: { loadProjectAgents: false },
      fs,
    })
    expect(r.section).toBe("")
  })

  it("resolves a global file under the home dir", async () => {
    const fs = fakeFs({
      "/home/.cognia/AGENTS.md": "global rules",
      "/proj/CLAUDE.md": "root",
    })
    const r = await loadProjectInstructions({
      isTauriEnv: true,
      homeDir: "/home",
      now: () => 1,
      cwd: "/proj",
      roots: ["/proj"],
      config: { loadProjectAgents: false },
      fs,
    })
    expect(r.files.map((f) => f.source)).toEqual(["global", "project"])
    expect(r.section).toContain("global rules")
  })
})
