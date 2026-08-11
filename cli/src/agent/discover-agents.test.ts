/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applySubagentModelOverrides,
  buildAgents,
  discoverAgentFiles,
  discoverDispatchableAgents,
  type AgentFs,
  type AgentSummary,
} from "./discover-agents"

function fakeFs(files: Record<string, string>): AgentFs {
  return {
    async exists(p) {
      return Object.keys(files).some((f) => f === p || f.startsWith(p + path.sep))
    },
    async readDir(p) {
      return Object.keys(files)
        .filter((f) => path.dirname(f) === p)
        .map((f) => path.basename(f))
    },
    async readText(p) {
      const v = files[p]
      if (v === undefined) throw new Error("ENOENT")
      return v
    },
  }
}

const AGENT_MD = `---
name: reviewer
description: reviews code
tools: read, grep
---
You are a careful code reviewer.`

describe("discoverAgentFiles", () => {
  it("collects .md files from each root's .cognia/agents dir", async () => {
    const root = "/proj"
    const dir = path.join(root, ".cognia", "agents")
    const fs = fakeFs({
      [path.join(dir, "reviewer.md")]: AGENT_MD,
      [path.join(dir, "notes.txt")]: "ignore me",
    })
    const files = await discoverAgentFiles([root], fs)
    expect(files).toEqual([{ id: "reviewer", content: AGENT_MD }])
  })

  it("returns nothing when the agents dir is absent", async () => {
    const files = await discoverAgentFiles(["/empty"], fakeFs({}))
    expect(files).toEqual([])
  })

  it("de-duplicates by id across roots (first root wins)", async () => {
    const a = path.join("/proj", ".cognia", "agents", "reviewer.md")
    const b = path.join("/home", ".cognia", "agents", "reviewer.md")
    const files = await discoverAgentFiles(
      ["/proj", "/home"],
      fakeFs({ [a]: AGENT_MD, [b]: "other" })
    )
    expect(files).toHaveLength(1)
    expect(files[0].content).toBe(AGENT_MD)
  })
})

describe("discoverAgentFiles (real node fs)", () => {
  it("reads real .cognia/agents/*.md and ignores a missing root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agents-"))
    const dir = path.join(root, ".cognia", "agents")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "reviewer.md"), AGENT_MD)
    try {
      const files = await discoverAgentFiles([root, path.join(root, "missing")])
      expect(files).toEqual([{ id: "reviewer", content: AGENT_MD }])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("buildAgents", () => {
  it("parses markdown agent files into dispatchable defs", () => {
    const agents = buildAgents([{ id: "reviewer", content: AGENT_MD }])
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: "reviewer",
      name: "reviewer",
      description: "reviews code",
    })
    expect(agents[0].def.prompt).toContain("careful code reviewer")
  })

  it("ignores malformed files", () => {
    expect(buildAgents([{ id: "bad", content: "no frontmatter here" }])).toEqual([])
  })
})

const CLAUDE_AGENT_MD = `---
name: cc-reviewer
description: Claude Code reviewer
tools: Read, Grep
model: sonnet
---
You are a Claude Code reviewer.`

const CODEX_AGENT_MD = `---
name: codex-refactor
description: Codex refactor bot
model: gpt-4o-mini
provider: openai
---
You refactor code for clarity.`

describe("discoverDispatchableAgents", () => {
  it("autonomously reuses Claude Code (.claude/agents) and Codex (.codex/agents) subagents", async () => {
    const root = "/proj"
    const ccFile = path.join(root, ".claude", "agents", "cc-reviewer.md")
    const codexFile = path.join(root, ".codex", "agents", "codex-refactor.md")
    const agents = await discoverDispatchableAgents(
      [root],
      fakeFs({ [ccFile]: CLAUDE_AGENT_MD, [codexFile]: CODEX_AGENT_MD })
    )
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]))
    expect(byId["cc-reviewer"]).toMatchObject({ description: "Claude Code reviewer" })
    expect(byId["cc-reviewer"].def.prompt).toContain("Claude Code reviewer")
    expect(byId["codex-refactor"]).toMatchObject({ description: "Codex refactor bot" })
  })

  it("carries the upstream model + native provider so the reused agent runs on its own provider", async () => {
    const ccFile = path.join("/p", ".claude", "agents", "cc-reviewer.md")
    const [agent] = await discoverDispatchableAgents(["/p"], fakeFs({ [ccFile]: CLAUDE_AGENT_MD }))
    // Claude Code agents map to the `anthropic` provider; the model is kept.
    expect(agent.def.provider).toBe("anthropic")
    expect(agent.def.model).toBe("sonnet")
    // Tools are preserved (the runner narrows the allowlist).
    expect(agent.def.tools).toEqual(["Read", "Grep"])
  })

  it("inherits the active provider for a provider-agnostic external agent", async () => {
    const ccFile = path.join("/p", ".claude", "agents", "analyze-rust-core.md")
    const markdown = `---\nname: analyze-rust-core\ndescription: Analyze the Rust core\ntools: Read, Grep\n---\nInspect the Rust backend.`
    const [agent] = await discoverDispatchableAgents(["/p"], fakeFs({ [ccFile]: markdown }))

    expect(agent.def.provider).toBeUndefined()
    expect(agent.def.model).toBeUndefined()
  })

  it("maps a Codex agent to the openai provider", async () => {
    const codexFile = path.join("/p", ".codex", "agents", "codex-refactor.md")
    const [agent] = await discoverDispatchableAgents(
      ["/p"],
      fakeFs({ [codexFile]: CODEX_AGENT_MD })
    )
    expect(agent.def.provider).toBe("openai")
    expect(agent.def.model).toBe("gpt-4o-mini")
  })

  it("lets a native .cognia/agents file win on an id collision", async () => {
    const native = path.join("/proj", ".cognia", "agents", "cc-reviewer.md")
    const external = path.join("/proj", ".claude", "agents", "cc-reviewer.md")
    const nativeMd = `---\nname: cc-reviewer\ndescription: native wins\n---\nNative body.`
    const agents = await discoverDispatchableAgents(
      ["/proj"],
      fakeFs({ [native]: nativeMd, [external]: CLAUDE_AGENT_MD })
    )
    const match = agents.filter((a) => a.id === "cc-reviewer")
    expect(match).toHaveLength(1)
    expect(match[0].description).toBe("native wins")
  })

  it("parses the Codex single-file YAML-array form (.codex/agents.md)", async () => {
    const codexArray = path.join("/proj", ".codex", "agents.md")
    const yaml = `- name: yaml-agent\n  description: from a yaml array\n  system_prompt: Do the thing.`
    const agents = await discoverDispatchableAgents(["/proj"], fakeFs({ [codexArray]: yaml }))
    expect(agents.find((a) => a.id === "yaml-agent")).toMatchObject({
      description: "from a yaml array",
    })
  })

  it("returns nothing (no throw) when no agent sources exist", async () => {
    expect(await discoverDispatchableAgents(["/empty"], fakeFs({}))).toEqual([])
  })

  it("prefers the project root over home for a duplicate external id", async () => {
    const proj = path.join("/proj", ".claude", "agents", "cc-reviewer.md")
    const home = path.join("/home", ".claude", "agents", "cc-reviewer.md")
    const homeMd = `---\nname: cc-reviewer\ndescription: home copy\n---\nHome body.`
    const agents = await discoverDispatchableAgents(
      ["/proj", "/home"],
      fakeFs({ [proj]: CLAUDE_AGENT_MD, [home]: homeMd })
    )
    const match = agents.filter((a) => a.id === "cc-reviewer")
    expect(match).toHaveLength(1)
    expect(match[0].description).toBe("Claude Code reviewer")
  })
})

describe("applySubagentModelOverrides", () => {
  function agent(id: string, def: Partial<AgentSummary["def"]> = {}): AgentSummary {
    return {
      id,
      name: id,
      description: "",
      def: { id, name: id, description: "", prompt: "p", ...def },
    }
  }

  it("returns the input unchanged when there are no overrides", () => {
    const agents = [agent("a")]
    expect(applySubagentModelOverrides(agents, undefined)).toBe(agents)
    expect(applySubagentModelOverrides(agents, {})).toBe(agents)
  })

  it("overlays a model override onto the matching agent only", () => {
    const out = applySubagentModelOverrides([agent("a"), agent("b")], { a: { model: "gpt-4o" } })
    expect(out[0].def.model).toBe("gpt-4o")
    expect(out[1].def.model).toBeUndefined()
  })

  it("overlays both provider and model", () => {
    const out = applySubagentModelOverrides(
      [agent("a", { model: "sonnet", provider: "anthropic" })],
      {
        a: { provider: "openai", model: "gpt-4o" },
      }
    )
    expect(out[0].def.provider).toBe("openai")
    expect(out[0].def.model).toBe("gpt-4o")
  })

  it("drops the frontmatter model on a provider-only override", () => {
    const out = applySubagentModelOverrides([agent("a", { model: "sonnet" })], {
      a: { provider: "openai" },
    })
    expect(out[0].def.provider).toBe("openai")
    expect(out[0].def.model).toBeUndefined()
  })

  it("does not mutate the input agents", () => {
    const agents = [agent("a", { model: "sonnet" })]
    applySubagentModelOverrides(agents, { a: { model: "gpt-4o" } })
    expect(agents[0].def.model).toBe("sonnet")
  })
})
