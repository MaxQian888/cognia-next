/**
 * @jest-environment node
 */
import { createMentionProviders } from "./providers"
import type { Skill } from "@/lib/claude/types"
import type { DirEntry } from "../commands/file-completer"
import type { AgentSummary } from "../../agent/discover-agents"

const skill = (over: Partial<Skill>): Skill =>
  ({
    id: "skill_x",
    name: "Skill X",
    content: "body",
    ...over,
  }) as Skill

const agent = (over: Partial<AgentSummary>): AgentSummary => ({
  id: "code-reviewer",
  name: "code-reviewer",
  description: "Reviews code",
  def: { id: "code-reviewer", name: "code-reviewer", description: "", prompt: "" },
  ...over,
})

const noop = async () => undefined

function makeDeps(over: Partial<Parameters<typeof createMentionProviders>[0]> = {}) {
  return {
    cwd: "/proj",
    home: "/home/.cognia",
    osHome: "/home",
    roots: ["/proj"],
    ensureDb: noop,
    seedSkills: noop,
    listSkills: async () => [skill({})],
    listAgents: async () => [agent({})],
    ...over,
  }
}

describe("createMentionProviders.files", () => {
  const listing: Record<string, DirEntry[]> = {
    ".": [
      { name: "src", isDir: true },
      { name: "readme.md", isDir: false },
    ],
  }
  const listDir = (dir: string): DirEntry[] => listing[dir] ?? []

  it("maps completeAtPath results to file candidates", () => {
    const p = createMentionProviders(makeDeps())
    const out = p.files("", listDir)
    expect(out).toEqual([
      { kind: "file", id: "@src/", label: "@src/", insert: "@src/" },
      { kind: "file", id: "@readme.md", label: "@readme.md", insert: "@readme.md" },
    ])
  })

  it("filters by the query prefix", () => {
    const p = createMentionProviders(makeDeps())
    expect(p.files("read", listDir).map((c) => c.id)).toEqual(["@readme.md"])
  })
})

describe("createMentionProviders.skills", () => {
  it("lists skills as candidates with origin + insert token", async () => {
    const p = createMentionProviders(
      makeDeps({
        listSkills: async () => [
          skill({
            id: "skill_cite",
            name: "Cite sources",
            description: "cite",
            canonicalId: "cli-disk:claude:cite",
          }),
        ],
      })
    )
    const out = await p.skills("")
    expect(out).toEqual([
      {
        kind: "skill",
        id: "skill_cite",
        label: "Cite sources",
        hint: "cite",
        origin: "claude",
        insert: "@skill:skill_cite",
      },
    ])
  })

  it("filters case-insensitively by name and id", async () => {
    const p = createMentionProviders(
      makeDeps({
        listSkills: async () => [
          skill({ id: "skill_cite", name: "Cite sources" }),
          skill({ id: "skill_concise", name: "Concise answers" }),
        ],
      })
    )
    expect((await p.skills("CITE")).map((c) => c.id)).toEqual(["skill_cite"])
    expect((await p.skills("concise")).map((c) => c.id)).toEqual(["skill_concise"])
  })

  it("caches after the first load (seed + list run once)", async () => {
    let seeds = 0
    let lists = 0
    const p = createMentionProviders(
      makeDeps({
        seedSkills: async () => {
          seeds++
        },
        listSkills: async () => {
          lists++
          return [skill({})]
        },
      })
    )
    await p.skills("a")
    await p.skills("b")
    expect(seeds).toBe(1)
    expect(lists).toBe(1)
  })

  it("degrades to [] when discovery throws and retries next call", async () => {
    let calls = 0
    const p = createMentionProviders(
      makeDeps({
        listSkills: async () => {
          calls++
          if (calls === 1) throw new Error("db locked")
          return [skill({})]
        },
      })
    )
    expect(await p.skills("")).toEqual([])
    expect((await p.skills("")).length).toBe(1) // retried, cached now
  })
})

describe("createMentionProviders.agents", () => {
  it("lists agents as candidates with the @agent: insert token", async () => {
    const p = createMentionProviders(
      makeDeps({
        listAgents: async () => [
          agent({ id: "researcher", name: "researcher", description: "digs" }),
        ],
      })
    )
    expect(await p.agents("")).toEqual([
      {
        kind: "agent",
        id: "researcher",
        label: "researcher",
        hint: "digs",
        origin: "agent",
        insert: "@agent:researcher",
      },
    ])
  })

  it("filters by query and caches", async () => {
    let lists = 0
    const p = createMentionProviders(
      makeDeps({
        listAgents: async () => {
          lists++
          return [agent({ id: "code-reviewer" }), agent({ id: "researcher", name: "researcher" })]
        },
      })
    )
    expect((await p.agents("research")).map((c) => c.id)).toEqual(["researcher"])
    await p.agents("code")
    expect(lists).toBe(1)
  })

  it("degrades to [] when agent discovery throws", async () => {
    const p = createMentionProviders(
      makeDeps({
        listAgents: async () => {
          throw new Error("nope")
        },
      })
    )
    expect(await p.agents("")).toEqual([])
  })

  it("uses the default disk discovery when listAgents is omitted (no dir → [])", async () => {
    // Point roots at a directory with no `.cognia/agents`; the default
    // discoverAgentFiles path returns no files → no candidates.
    const p = createMentionProviders({
      cwd: "/nonexistent-proj-xyz",
      home: "/nonexistent-home-xyz",
      osHome: "/nonexistent-os-xyz",
      roots: ["/nonexistent-proj-xyz"],
      // listSkills/seedSkills/ensureDb injected so skills don't touch a real db.
      ensureDb: async () => undefined,
      seedSkills: async () => undefined,
      listSkills: async () => [],
    })
    expect(await p.agents("")).toEqual([])
  })
})

describe("createMentionProviders scan options", () => {
  it("builds default skill scan options (osHome + external) when seedSkills is omitted", async () => {
    // Omit seedSkills so the default seeder (which calls scanOptionsOf) runs.
    // Inject ensureDb + listSkills so no real db is touched; the seeder scans
    // nonexistent dirs → no-op, then listSkills returns the injected fixture.
    const p = createMentionProviders({
      cwd: "/nonexistent-proj-xyz",
      home: "/nonexistent-home-xyz",
      roots: ["/nonexistent-proj-xyz"],
      externalSkills: false,
      skillDirs: ["/nonexistent-custom-xyz"],
      ensureDb: async () => undefined,
      listSkills: async () => [skill({ id: "skill_y", name: "Skill Y" })],
    })
    const out = await p.skills("")
    expect(out.map((c) => c.id)).toEqual(["skill_y"])
  })
})
