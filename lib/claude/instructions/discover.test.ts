import { discoverInstructionPaths } from "./discover"
import { resolveInstructionsConfig, type InstructionFs } from "./types"

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
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length)
          if (!rest.includes("/")) names.add(rest)
        }
      }
      if (names.size === 0 && !map.has(norm(p))) {
        // emulate readDir throwing on a missing directory
        const hasChildren = [...map.keys()].some((k) => k.startsWith(prefix))
        if (!hasChildren) throw new Error(`ENOENT ${p}`)
      }
      return [...names]
    },
    async readText(p) {
      const v = map.get(norm(p))
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
  }
}

const cfg = resolveInstructionsConfig

describe("discoverInstructionPaths — layered", () => {
  it("collects every ancestor file root→cwd, nearest last", async () => {
    const fs = fakeFs({
      "/proj/CLAUDE.md": "root",
      "/proj/sub/AGENT.md": "sub",
      "/proj/sub/deep/AGENTS.md": "deep",
    })
    const r = await discoverInstructionPaths({
      cwd: "/proj/sub/deep",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual([
      "/proj/CLAUDE.md",
      "/proj/sub/AGENT.md",
      "/proj/sub/deep/AGENTS.md",
    ])
    expect(r.map((f) => f.label)).toEqual(["CLAUDE.md", "sub/AGENT.md", "sub/deep/AGENTS.md"])
  })

  it("applies same-dir precedence AGENTS.md > AGENT.md > CLAUDE.md", async () => {
    const fs = fakeFs({
      "/proj/AGENTS.md": "a",
      "/proj/AGENT.md": "b",
      "/proj/CLAUDE.md": "c",
    })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual(["/proj/AGENTS.md"])
  })
})

describe("discoverInstructionPaths — nearest", () => {
  it("stops at the first ancestor dir with a file", async () => {
    const fs = fakeFs({
      "/proj/CLAUDE.md": "root",
      "/proj/sub/AGENT.md": "sub",
    })
    const r = await discoverInstructionPaths({
      cwd: "/proj/sub/deep",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false, mode: "nearest" }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual(["/proj/sub/AGENT.md"])
  })
})

describe("discoverInstructionPaths — global + dir + extra", () => {
  it("prepends the global file and appends .cognia/instructions + extras", async () => {
    const fs = fakeFs({
      "/home/.cognia/AGENTS.md": "global",
      "/proj/CLAUDE.md": "root",
      "/proj/.cognia/instructions/a.md": "ia",
      "/proj/.cognia/instructions/b.md": "ib",
      "/proj/docs/extra.md": "extra",
    })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      globalPath: "/home/.cognia/AGENTS.md",
      config: cfg({ extraPaths: ["docs/extra.md"] }),
      fs,
    })
    expect(r.map((f) => f.source)).toEqual([
      "global",
      "project",
      "instructions-dir",
      "instructions-dir",
      "extra",
    ])
    expect(r.map((f) => f.absPath)).toEqual([
      "/home/.cognia/AGENTS.md",
      "/proj/CLAUDE.md",
      "/proj/.cognia/instructions/a.md",
      "/proj/.cognia/instructions/b.md",
      "/proj/docs/extra.md",
    ])
  })

  it("supports a trailing *.md glob in extraPaths and dedupes", async () => {
    const fs = fakeFs({
      "/proj/rules/x.md": "x",
      "/proj/rules/y.md": "y",
      "/proj/CLAUDE.md": "root",
    })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false, extraPaths: ["rules/*.md", "CLAUDE.md"] }),
      fs,
    })
    // CLAUDE.md already discovered as project → extra dedupes it away.
    expect(r.map((f) => f.absPath)).toEqual([
      "/proj/CLAUDE.md",
      "/proj/rules/x.md",
      "/proj/rules/y.md",
    ])
  })
})

describe("discoverInstructionPaths — extra + error paths", () => {
  it("skips extra globs whose dir is missing and plain files that don't exist", async () => {
    const fs = fakeFs({ "/proj/CLAUDE.md": "root" })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false, extraPaths: ["missing/*.md", "nope.md"] }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual(["/proj/CLAUDE.md"])
  })

  it("labels an absolute extra file outside any root by basename", async () => {
    const fs = fakeFs({ "/elsewhere/x.md": "x" })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false, extraPaths: ["/elsewhere/x.md"] }),
      fs,
    })
    expect(r).toEqual([{ absPath: "/elsewhere/x.md", label: "x.md", source: "extra" }])
  })

  it("walks to the fs root (basename labels) when cwd is outside every workspace root", async () => {
    const fs = fakeFs({ "/other/sub/CLAUDE.md": "x" })
    const r = await discoverInstructionPaths({
      cwd: "/other/sub",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false }),
      fs,
    })
    expect(r).toEqual([{ absPath: "/other/sub/CLAUDE.md", label: "CLAUDE.md", source: "project" }])
  })

  it("supports an extension-less trailing glob in extraPaths", async () => {
    const fs = fakeFs({ "/proj/rules/a.md": "a", "/proj/rules/b.txt": "b" })
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      config: cfg({ includeGlobal: false, extraPaths: ["rules/*"] }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual(["/proj/rules/a.md", "/proj/rules/b.txt"])
  })

  it("survives an exists() that throws while scanning", async () => {
    const fs: InstructionFs = {
      async exists() {
        throw new Error("EACCES")
      },
      async readDir() {
        throw new Error("EACCES")
      },
      async readText() {
        throw new Error("EACCES")
      },
    }
    const r = await discoverInstructionPaths({
      cwd: "/proj",
      roots: ["/proj"],
      globalPath: "/home/AGENTS.md",
      config: cfg({ extraPaths: ["a.md"] }),
      fs,
    })
    expect(r).toEqual([])
  })
})

describe("discoverInstructionPaths — no cwd", () => {
  it("still returns global + instructions-dir without an ancestor walk", async () => {
    const fs = fakeFs({ "/proj/.cognia/instructions/a.md": "ia" })
    const r = await discoverInstructionPaths({
      roots: ["/proj"],
      config: cfg({ includeGlobal: false }),
      fs,
    })
    expect(r.map((f) => f.absPath)).toEqual(["/proj/.cognia/instructions/a.md"])
  })
})
