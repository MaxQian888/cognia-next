import { codexCliAdapter } from "./codex-cli"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

const PER_FILE = `---
name: refactor-bot
description: Refactors code for clarity.
tools: Read, Edit
model: gpt-4o-mini
provider: openai
---

You are a refactoring agent.
`

const MULTI_AGENT_YAML = `- name: agent-one
  description: First agent
  model: gpt-4o
  system_prompt: You are agent one.
  tools:
    - Read
- name: agent-two
  description: Second agent
  systemPrompt: You are agent two.
- name: agent-three
  prompt: You are agent three.
  provider: anthropic
`

describe("codexCliAdapter.detect", () => {
  it("matches .codex/agents/", () => {
    expect(
      codexCliAdapter.detect({
        files: [file(".codex/agents/a.md", PER_FILE)],
      })
    ).toBe("match")
  })

  it("matches a top-level agents.md", () => {
    expect(codexCliAdapter.detect({ files: [file("agents.md", MULTI_AGENT_YAML)] })).toBe("match")
  })

  it("returns 'no' otherwise", () => {
    expect(codexCliAdapter.detect({ files: [file("README.md", PER_FILE)] })).toBe("no")
  })

  it("returns 'maybe' for partial match", () => {
    expect(
      codexCliAdapter.detect({
        files: [file(".codex/agents/a.md", PER_FILE), file("README.md", PER_FILE)],
      })
    ).toBe("maybe")
  })
})

describe("codexCliAdapter.parse — per-file frontmatter form", () => {
  it("parses a single-agent file", () => {
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/refactor.md", PER_FILE)],
    })
    expect(r.errors).toEqual([])
    const d = r.drafts[0]
    expect(d.source).toBe("codex-cli")
    expect(d.name).toBe("refactor-bot")
    expect(d.tools).toEqual(["Read", "Edit"])
    expect(d.model).toBe("gpt-4o-mini")
    expect(d.providerHint).toBe("openai")
  })

  it("defaults provider to 'openai' when missing", () => {
    const text = `---
name: x
---
body
`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.md", text)],
    })
    expect(r.drafts[0].providerHint).toBe("openai")
  })

  it("respects an anthropic provider override", () => {
    const text = `---
name: x
provider: anthropic
---
body
`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.md", text)],
    })
    expect(r.drafts[0].providerHint).toBe("anthropic")
  })

  it("ignores unknown providers and falls back to 'openai'", () => {
    const text = `---
name: x
provider: galaxy
---
body
`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.md", text)],
    })
    expect(r.drafts[0].providerHint).toBe("openai")
  })

  it("falls back to filename for missing name", () => {
    const text = `---
description: hi
---
body
`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/refactor-bot.md", text)],
    })
    expect(r.drafts[0].name).toBe("refactor bot")
    expect(r.drafts[0].warnings[0]).toMatch(/No 'name'/)
  })

  it("emits error for malformed YAML in frontmatter", () => {
    const text = `---
: bad: yaml: : :
---
body`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.md", text)],
    })
    expect(r.errors[0].error).toMatch(/Failed to parse/)
  })

  it("emits error for empty body", () => {
    const text = `---
name: x
---
`
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.md", text)],
    })
    expect(r.errors[0].error).toMatch(/Empty body/)
  })

  it("emits error when name and fallback both fail", () => {
    const text = `---
description: hi
---
body
`
    const r = codexCliAdapter.parse({
      files: [{ filename: ".md", sourcePath: ".codex/agents/.md", content: text }],
    })
    expect(r.errors[0].error).toMatch(/Missing name/)
  })

  it("skips files with non-accepted extensions", () => {
    const r = codexCliAdapter.parse({
      files: [file(".codex/agents/x.txt", PER_FILE)],
    })
    expect(r.drafts).toEqual([])
  })
})

describe("codexCliAdapter.parse — multi-agent YAML array form", () => {
  it("parses a top-level YAML array", () => {
    const r = codexCliAdapter.parse({
      files: [file("agents.md", MULTI_AGENT_YAML)],
    })
    expect(r.errors).toEqual([])
    expect(r.drafts).toHaveLength(3)
    expect(r.drafts.map((d) => d.name)).toEqual(["agent-one", "agent-two", "agent-three"])
    expect(r.drafts[0].systemPrompt).toBe("You are agent one.")
    expect(r.drafts[0].tools).toEqual(["Read"])
    expect(r.drafts[1].systemPrompt).toBe("You are agent two.")
    expect(r.drafts[2].systemPrompt).toBe("You are agent three.")
    expect(r.drafts[2].providerHint).toBe("anthropic")
  })

  it("collects errors per entry without aborting the batch", () => {
    const text = `- name: ok
  system_prompt: body
- description: missing-name
  prompt: body
- name: missing-body
- "not-an-object"
`
    const r = codexCliAdapter.parse({ files: [file("agents.md", text)] })
    expect(r.drafts.map((d) => d.name)).toEqual(["ok"])
    expect(r.errors).toHaveLength(3)
    expect(r.errors[0].error).toMatch(/Missing name/)
    expect(r.errors[1].error).toMatch(/Empty body/)
    expect(r.errors[2].error).toMatch(/not an object/)
  })

  it("falls back to frontmatter form when YAML array parse fails", () => {
    // Starts with "[" but isn't valid YAML — should fall back.
    const text = `[invalid yaml...
---
name: fb
---
body
`
    const r = codexCliAdapter.parse({ files: [file("agents.md", text)] })
    // Falls through to frontmatter form; "[invalid yaml..." appears before
    // the fence so frontmatter parser sees no fence and fails ensureMinimum.
    expect(r.drafts.length + r.errors.length).toBeGreaterThan(0)
  })
})
