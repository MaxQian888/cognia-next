/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildAgents, discoverAgentFiles, type AgentFs } from "./discover-agents"

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
