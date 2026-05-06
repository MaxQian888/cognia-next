import { genericMdAdapter } from "./generic-md"
import type { ImportFile } from "./types"

function file(path: string, content: string, filename?: string): ImportFile {
  const fname = filename ?? path.split("/").pop() ?? path
  return { filename: fname, sourcePath: path, content }
}

describe("genericMdAdapter.detect", () => {
  it("returns 'maybe' for any .md file (never 'match' — fallback)", () => {
    expect(genericMdAdapter.detect({ files: [file("foo.md", "hi")] })).toBe("maybe")
  })

  it("returns 'no' for non-md", () => {
    expect(genericMdAdapter.detect({ files: [file("foo.txt", "hi")] })).toBe("no")
  })
})

describe("genericMdAdapter.parse", () => {
  it("uses 'name' field", () => {
    const text = `---
name: foo
description: bar
tools: [Read]
model: sonnet
provider: anthropic
---
body
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.errors).toEqual([])
    const d = r.drafts[0]
    expect(d.name).toBe("foo")
    expect(d.description).toBe("bar")
    expect(d.tools).toEqual(["Read"])
    expect(d.model).toBe("sonnet")
    expect(d.providerHint).toBe("anthropic")
  })

  it("falls back to 'title' when 'name' missing", () => {
    const text = `---
title: My Agent
summary: a summary
---
body
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].name).toBe("My Agent")
    expect(r.drafts[0].description).toBe("a summary")
  })

  it("falls back to filename for missing name+title", () => {
    const r = genericMdAdapter.parse({
      files: [file("my-agent.md", "body")],
    })
    expect(r.drafts[0].name).toBe("my agent")
    expect(r.drafts[0].warnings[0]).toMatch(/No 'name' or 'title'/)
  })

  it("respects explicit system_prompt over body", () => {
    const text = `---
name: x
system_prompt: Explicit prompt.
---
This body should be ignored.
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].systemPrompt).toBe("Explicit prompt.")
  })

  it("respects systemPrompt camelCase variant", () => {
    const text = `---
name: x
systemPrompt: Camel prompt.
---
ignored
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].systemPrompt).toBe("Camel prompt.")
  })

  it("respects 'prompt' as another alias", () => {
    const text = `---
name: x
prompt: Plain prompt.
---
ignored
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].systemPrompt).toBe("Plain prompt.")
  })

  it("accepts 'allowed-tools' kebab", () => {
    const text = `---
name: x
allowed-tools: Read, Write
---
body
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].tools).toEqual(["Read", "Write"])
  })

  it("accepts 'allowedTools' camel", () => {
    const text = `---
name: x
allowedTools:
  - Read
---
body
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].tools).toEqual(["Read"])
  })

  it("ignores unknown providers", () => {
    const text = `---
name: x
provider: galaxy
---
body
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.drafts[0].providerHint).toBeUndefined()
  })

  it("emits error for empty body", () => {
    const text = `---
name: x
---
`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.errors[0].error).toMatch(/Empty body/)
  })

  it("emits error for malformed YAML", () => {
    const text = `---
: bad: yaml: : :
---
body`
    const r = genericMdAdapter.parse({ files: [file("x.md", text)] })
    expect(r.errors[0].error).toMatch(/Failed to parse/)
  })

  it("skips non-accepted extensions", () => {
    const r = genericMdAdapter.parse({ files: [file("x.txt", "body")] })
    expect(r.drafts).toEqual([])
  })

  it("emits error when no name+title+filename fallback works", () => {
    const text = `---
description: hi
---
body
`
    const r = genericMdAdapter.parse({
      files: [{ filename: ".md", sourcePath: ".md", content: text }],
    })
    expect(r.errors[0].error).toMatch(/Missing name/)
  })
})
