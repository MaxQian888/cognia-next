import { claudeCodeAdapter } from "./claude-code"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

const SAMPLE = `---
name: code-reviewer
description: Reviews code for quality.
tools: Read, Grep, Glob
model: sonnet
---

You are a senior reviewer.
Look for bugs and style issues.
`

describe("claudeCodeAdapter.detect", () => {
  it("returns 'match' when every file is under .claude/agents/", () => {
    expect(
      claudeCodeAdapter.detect({
        files: [file(".claude/agents/a.md", SAMPLE), file(".claude/agents/b.md", SAMPLE)],
      })
    ).toBe("match")
  })

  it("normalizes Windows backslashes", () => {
    expect(
      claudeCodeAdapter.detect({
        files: [file(".claude\\agents\\a.md", SAMPLE)],
      })
    ).toBe("match")
  })

  it("returns 'maybe' when only some files match", () => {
    expect(
      claudeCodeAdapter.detect({
        files: [file(".claude/agents/a.md", SAMPLE), file("docs/whatever.md", SAMPLE)],
      })
    ).toBe("maybe")
  })

  it("returns 'no' when none match", () => {
    expect(claudeCodeAdapter.detect({ files: [file("README.md", SAMPLE)] })).toBe("no")
  })

  it("returns 'no' on non-md files", () => {
    expect(
      claudeCodeAdapter.detect({
        files: [file(".claude/agents/a.json", SAMPLE)],
      })
    ).toBe("no")
  })
})

describe("claudeCodeAdapter.parse", () => {
  it("parses a well-formed claude code subagent", () => {
    const r = claudeCodeAdapter.parse({
      files: [file(".claude/agents/code-reviewer.md", SAMPLE)],
    })
    expect(r.errors).toEqual([])
    expect(r.drafts).toHaveLength(1)
    const d = r.drafts[0]
    expect(d.source).toBe("claude-code")
    expect(d.name).toBe("code-reviewer")
    expect(d.sourceKey).toBe("claude-code:code-reviewer")
    expect(d.description).toBe("Reviews code for quality.")
    expect(d.tools).toEqual(["Read", "Grep", "Glob"])
    expect(d.model).toBe("sonnet")
    expect(d.providerHint).toBe("anthropic")
    expect(d.systemPrompt).toContain("senior reviewer")
    expect(d.warnings).toEqual([])
    expect(d.sourceFile).toBe(".claude/agents/code-reviewer.md")
  })

  it("accepts tools as YAML array", () => {
    const text = `---
name: x
tools:
  - Read
  - Write
---

Body.`
    const r = claudeCodeAdapter.parse({ files: [file(".claude/agents/x.md", text)] })
    expect(r.drafts[0].tools).toEqual(["Read", "Write"])
  })

  it("falls back to filename when name is missing", () => {
    const text = `---
description: hi
---

body
`
    const r = claudeCodeAdapter.parse({
      files: [file(".claude/agents/code-reviewer.md", text)],
    })
    expect(r.drafts[0].name).toBe("code reviewer")
    expect(r.drafts[0].warnings[0]).toMatch(/No 'name' in frontmatter/)
  })

  it("emits error for empty body", () => {
    const text = `---
name: x
---
`
    const r = claudeCodeAdapter.parse({ files: [file(".claude/agents/x.md", text)] })
    expect(r.drafts).toEqual([])
    expect(r.errors[0].error).toMatch(/Empty body/)
  })

  it("emits error for malformed YAML", () => {
    const text = `---
: bad: yaml: : :
---
body`
    const r = claudeCodeAdapter.parse({ files: [file(".claude/agents/x.md", text)] })
    expect(r.drafts).toEqual([])
    expect(r.errors[0].error).toMatch(/Failed to parse/)
  })

  it("skips non-md files silently", () => {
    const r = claudeCodeAdapter.parse({
      files: [file(".claude/agents/x.txt", SAMPLE)],
    })
    expect(r.drafts).toEqual([])
    expect(r.errors).toEqual([])
  })

  it("emits error when neither name nor filename produces a fallback", () => {
    // filename without extension and without printable chars
    const text = `---
description: hi
---
body
`
    const r = claudeCodeAdapter.parse({
      files: [{ filename: ".md", sourcePath: ".claude/agents/.md", content: text }],
    })
    expect(r.errors[0].error).toMatch(/Missing name/)
  })
})
