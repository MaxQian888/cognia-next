import { piAdapter } from "./pi"
import type { ImportFile } from "./types"

/** Mirrors `.pi/agents/reviewer.md` as this repo actually ships it. */
const REVIEWER = `---
description: Read-only correctness, security, and regression reviewer
display_name: Reviewer
tools: read, grep, find, ls, bash
thinking: high
max_turns: 12
prompt_mode: append
inherit_context: true
run_in_background: true
permission:
  "*": deny
  read: allow
  bash: ask
---

Review the diff for correctness and regressions.
`

const file = (overrides: Partial<ImportFile> = {}): ImportFile => ({
  filename: "reviewer.md",
  sourcePath: ".pi/agents/reviewer.md",
  content: REVIEWER,
  ...overrides,
})

describe("piAdapter.detect", () => {
  it("matches files under .pi/agents/", () => {
    expect(piAdapter.detect({ files: [file()] })).toBe("match")
  })

  it("matches a Windows-separated path", () => {
    expect(
      piAdapter.detect({ files: [file({ sourcePath: "C:\\repo\\.pi\\agents\\reviewer.md" })] })
    ).toBe("match")
  })

  it("is unsure when only some files look like Pi's", () => {
    expect(
      piAdapter.detect({
        files: [file(), file({ sourcePath: ".claude/agents/other.md", filename: "other.md" })],
      })
    ).toBe("maybe")
  })

  it("declines a batch with no Pi paths", () => {
    expect(
      piAdapter.detect({ files: [file({ sourcePath: ".claude/agents/x.md", filename: "x.md" })] })
    ).toBe("no")
  })
})

describe("piAdapter.parse", () => {
  it("takes the identity from the filename, not a name field", () => {
    // Pi has no `name:` in frontmatter — the file name IS the agent name.
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts).toHaveLength(1)
    expect(drafts[0].name).toBe("reviewer")
    expect(drafts[0].source).toBe("pi")
  })

  it("reads the description and the comma-separated tool list", () => {
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts[0].description).toBe("Read-only correctness, security, and regression reviewer")
    expect(drafts[0].tools).toEqual(["read", "grep", "find", "ls", "bash"])
  })

  it("falls back to display_name when there is no description", () => {
    const content = REVIEWER.replace(
      "description: Read-only correctness, security, and regression reviewer\n",
      ""
    )
    const { drafts } = piAdapter.parse({ files: [file({ content })] })
    expect(drafts[0].description).toBe("Reviewer")
  })

  /**
   * The important one: Pi enforces a per-tool allow/ask/deny policy that
   * Cognia's subagent model cannot express. Importing silently would produce
   * an agent that looks the same but is materially more permissive.
   */
  it("warns that Pi's permission policy was not imported", () => {
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts[0].warnings.join(" ")).toContain("permission policy has no Cognia equivalent")
  })

  it("warns about the run_in_background runtime flag", () => {
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts[0].warnings.join(" ")).toContain("run_in_background")
  })

  it("leaves the model unset — Pi chooses it per session, not per agent", () => {
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts[0].model).toBeUndefined()
  })

  it("retains the raw frontmatter for fields it cannot map", () => {
    const { drafts } = piAdapter.parse({ files: [file()] })
    expect(drafts[0].rawFrontmatter).toMatchObject({
      max_turns: 12,
      prompt_mode: "append",
      thinking: "high",
    })
  })

  it("flags a thinking level Pi does not define", () => {
    const content = REVIEWER.replace("thinking: high", "thinking: ludicrous")
    const { drafts } = piAdapter.parse({ files: [file({ content })] })
    expect(drafts[0].warnings.join(" ")).toContain("ludicrous")
  })

  it("does not warn when there is no permission block", () => {
    const content = REVIEWER.replace(/permission:\n(?: {2}.*\n)+/, "")
    const { drafts } = piAdapter.parse({ files: [file({ content })] })
    expect(drafts[0].warnings.join(" ")).not.toContain("permission policy")
  })

  it("skips files that are not markdown", () => {
    const { drafts } = piAdapter.parse({
      files: [file({ filename: "reviewer.json", sourcePath: ".pi/agents/reviewer.json" })],
    })
    expect(drafts).toHaveLength(0)
  })

  it("reports a malformed frontmatter file as an error rather than throwing", () => {
    const { drafts, errors } = piAdapter.parse({
      files: [file({ content: "---\ndescription: [unclosed\n---\nbody" })],
    })
    expect(drafts).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].filename).toBe("reviewer.md")
  })
})
