import { discoverMarkdownAgentFiles } from "./discover-agents"
import { buildMarkdownAgents } from "@/lib/claude/agents/markdown-agents"
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

const A = (desc: string) => `---\ndescription: ${desc}\n---\nbody`

describe("discoverMarkdownAgentFiles", () => {
  it("reads .md files under each root's .cognia/agents and kebab-ids them", async () => {
    const fs = fakeFs({
      "/proj/.cognia/agents/Code Reviewer.md": A("review"),
      "/proj/.cognia/agents/notes.txt": "ignored",
    })
    const files = await discoverMarkdownAgentFiles({ roots: ["/proj"], fs })
    expect(files).toEqual([{ id: "code-reviewer", content: A("review") }])
  })

  it("orders global first and primary root last so primary wins on id collision", async () => {
    const fs = fakeFs({
      "/home/.cognia/agents/foo.md": A("global"),
      "/proj/.cognia/agents/foo.md": A("primary"),
      "/extra/.cognia/agents/foo.md": A("extra"),
    })
    const files = await discoverMarkdownAgentFiles({
      roots: ["/proj", "/extra"],
      globalAgentsDir: "/home/.cognia/agents",
      fs,
    })
    const { agents } = buildMarkdownAgents(files)
    expect(agents.foo.description).toBe("primary")
  })

  it("returns empty when no agents dirs exist", async () => {
    const fs = fakeFs({})
    expect(await discoverMarkdownAgentFiles({ roots: ["/proj"], fs })).toEqual([])
  })

  it("skips an unreadable agent file", async () => {
    const fs: InstructionFs = {
      async exists() {
        return true
      },
      async readDir() {
        return ["a.md", "b.md"]
      },
      async readText(p) {
        if (p.includes("a.md")) throw new Error("EACCES")
        return A("ok")
      },
    }
    const files = await discoverMarkdownAgentFiles({ roots: ["/proj"], fs })
    expect(files).toEqual([{ id: "b", content: A("ok") }])
  })
})
