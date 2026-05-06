import { cursorAdapter } from "./cursor"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

const SAMPLE_RULE = `---
description: Use modern TypeScript features.
globs:
  - "src/**/*.ts"
alwaysApply: true
---

Always prefer \`const\` and use strict types.
Avoid \`any\` outside escape hatches.
`

describe("cursorAdapter.detect", () => {
  it("matches .cursor/rules", () => {
    expect(cursorAdapter.detect({ files: [file(".cursor/rules/ts.mdc", SAMPLE_RULE)] })).toBe(
      "match"
    )
  })

  it("returns 'no' otherwise", () => {
    expect(cursorAdapter.detect({ files: [file("README.md", SAMPLE_RULE)] })).toBe("no")
  })

  it("returns 'maybe' for partial match", () => {
    expect(
      cursorAdapter.detect({
        files: [file(".cursor/rules/ts.mdc", SAMPLE_RULE), file("README.md", SAMPLE_RULE)],
      })
    ).toBe("maybe")
  })
})

describe("cursorAdapter.parse", () => {
  it("parses a typical .mdc rule, defaulting name from filename", () => {
    const r = cursorAdapter.parse({
      files: [file(".cursor/rules/typescript-style.mdc", SAMPLE_RULE)],
    })
    expect(r.errors).toEqual([])
    const d = r.drafts[0]
    expect(d.name).toBe("typescript style")
    expect(d.description).toBe("Use modern TypeScript features.")
    expect(d.systemPrompt).toContain("Always prefer")
    expect(d.tools).toBeUndefined()
    expect(d.model).toBeUndefined()
    expect(d.providerHint).toBeUndefined()
    expect(d.rawFrontmatter?.globs).toEqual(["src/**/*.ts"])
    expect(d.rawFrontmatter?.alwaysApply).toBe(true)
  })

  it("respects an explicit name in frontmatter", () => {
    const text = `---
name: My Rule
description: hi
---
body
`
    const r = cursorAdapter.parse({
      files: [file(".cursor/rules/x.mdc", text)],
    })
    expect(r.drafts[0].name).toBe("My Rule")
  })

  it("emits error for empty body", () => {
    const text = `---
description: hi
---
`
    const r = cursorAdapter.parse({
      files: [file(".cursor/rules/x.mdc", text)],
    })
    expect(r.errors[0].error).toMatch(/Empty body/)
  })

  it("emits error for malformed YAML", () => {
    const text = `---
: bad: yaml: : :
---
body`
    const r = cursorAdapter.parse({
      files: [file(".cursor/rules/x.mdc", text)],
    })
    expect(r.errors[0].error).toMatch(/Failed to parse/)
  })

  it("skips files with non-accepted extensions", () => {
    const r = cursorAdapter.parse({
      files: [file(".cursor/rules/x.txt", SAMPLE_RULE)],
    })
    expect(r.drafts).toEqual([])
  })

  it("emits error when no name fallback is available", () => {
    const text = `---
description: hi
---
body
`
    const r = cursorAdapter.parse({
      files: [{ filename: ".mdc", sourcePath: ".cursor/rules/.mdc", content: text }],
    })
    expect(r.errors[0].error).toMatch(/Missing name/)
  })
})
