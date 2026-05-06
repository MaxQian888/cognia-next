import { clineAdapter } from "./cline"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

describe("clineAdapter.detect", () => {
  it("matches .clinerules", () => {
    expect(
      clineAdapter.detect({
        files: [file(".clinerules/style.md", "Always use TypeScript.")],
      })
    ).toBe("match")
  })

  it("returns 'no' otherwise", () => {
    expect(clineAdapter.detect({ files: [file("README.md", "hi")] })).toBe("no")
  })

  it("returns 'maybe' for partial match", () => {
    expect(
      clineAdapter.detect({
        files: [file(".clinerules/a.md", "body"), file("docs/whatever.md", "body")],
      })
    ).toBe("maybe")
  })
})

describe("clineAdapter.parse", () => {
  it("parses a frontmatter-less rule, defaults name from filename", () => {
    const r = clineAdapter.parse({
      files: [file(".clinerules/code-style.md", "Use 2-space indent.")],
    })
    expect(r.errors).toEqual([])
    expect(r.drafts[0].name).toBe("code style")
    expect(r.drafts[0].systemPrompt).toBe("Use 2-space indent.")
    expect(r.drafts[0].rawFrontmatter).toBeUndefined()
  })

  it("parses with frontmatter when present", () => {
    const text = `---
name: My Rule
description: nice rule
---
body
`
    const r = clineAdapter.parse({
      files: [file(".clinerules/x.md", text)],
    })
    expect(r.drafts[0].name).toBe("My Rule")
    expect(r.drafts[0].description).toBe("nice rule")
    expect(r.drafts[0].rawFrontmatter).toEqual({
      name: "My Rule",
      description: "nice rule",
    })
  })

  it("emits error for empty body", () => {
    const r = clineAdapter.parse({
      files: [file(".clinerules/x.md", "")],
    })
    expect(r.errors[0].error).toMatch(/Empty body/)
  })

  it("emits error for malformed YAML", () => {
    const text = `---
: bad: yaml: : :
---
body`
    const r = clineAdapter.parse({
      files: [file(".clinerules/x.md", text)],
    })
    expect(r.errors[0].error).toMatch(/Failed to parse/)
  })

  it("skips non-md files", () => {
    const r = clineAdapter.parse({
      files: [file(".clinerules/x.txt", "body")],
    })
    expect(r.drafts).toEqual([])
  })

  it("emits error when no name fallback is available", () => {
    const r = clineAdapter.parse({
      files: [{ filename: ".md", sourcePath: ".clinerules/.md", content: "body" }],
    })
    expect(r.errors[0].error).toMatch(/Missing name/)
  })
})
