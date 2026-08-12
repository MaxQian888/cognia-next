import {
  detectArtifacts,
  detectArtifactType,
  detectStreamingArtifact,
  extractCodeBlocks,
  shouldAutoCreate,
  getBestArtifact,
  isCompleteArtifact,
  generateTitle,
  DEFAULT_DETECTION_CONFIG,
} from "./artifact-detector"
import detectorDefault from "./artifact-detector"

describe("detectArtifactType", () => {
  it("identifies Jupyter ahead of everything else", () => {
    const ipynb = '{"cells": [{"cell_type":"code"}], "nbformat": 4}'
    expect(detectArtifactType(ipynb).type).toBe("jupyter")
  })

  it("identifies mermaid by language hint or pattern", () => {
    expect(detectArtifactType("graph TD\nA-->B").type).toBe("mermaid")
    expect(detectArtifactType("anything", "mermaid").type).toBe("mermaid")
  })

  it("identifies math via $$ delimiters or latex language", () => {
    expect(detectArtifactType("$$\\frac{a}{b}$$").type).toBe("math")
    expect(detectArtifactType("anything", "latex").type).toBe("math")
    expect(detectArtifactType("anything", "tex").type).toBe("math")
  })

  it("identifies SVG", () => {
    expect(detectArtifactType('<svg xmlns="http://www.w3.org/2000/svg"></svg>').type).toBe("svg")
    expect(detectArtifactType("anything", "svg").type).toBe("svg")
  })

  it("identifies React via JSX", () => {
    expect(detectArtifactType("import React from 'react'\nfunction X(){return <div/>}").type).toBe(
      "react"
    )
    expect(detectArtifactType("anything", "tsx").type).toBe("react")
  })

  it("identifies HTML by doctype", () => {
    expect(detectArtifactType("<!DOCTYPE html><html></html>").type).toBe("html")
    expect(detectArtifactType("anything", "html").type).toBe("html")
  })

  it("identifies chart JSON", () => {
    expect(detectArtifactType('[{"name":"a","value":1}]').type).toBe("chart")
  })

  it("identifies markdown documents by language hint", () => {
    expect(detectArtifactType("anything", "markdown").type).toBe("document")
    expect(detectArtifactType("anything", "md").type).toBe("document")
  })

  it("falls back to code", () => {
    expect(detectArtifactType("just text", "javascript").type).toBe("code")
  })

  it("attaches a confidence score", () => {
    expect(detectArtifactType("$$x$$").confidence).toBeGreaterThan(0.5)
  })
})

describe("extractCodeBlocks", () => {
  it("returns an empty list when there are no fenced code blocks", () => {
    expect(extractCodeBlocks("plain text only")).toEqual([])
  })

  it("captures language and trimmed code", () => {
    const md = "before\n```python\nprint(1)\n```\nafter"
    const blocks = extractCodeBlocks(md)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].language).toBe("python")
    expect(blocks[0].code).toBe("print(1)")
  })

  it("captures multiple blocks", () => {
    const md = "```js\nconsole.log(1)\n```\n```python\nprint(2)\n```"
    expect(extractCodeBlocks(md)).toHaveLength(2)
  })

  it("treats unfenced language as empty string", () => {
    const md = "```\njust code\n```"
    const blocks = extractCodeBlocks(md)
    expect(blocks[0].language).toBe("")
  })
})

describe("shouldAutoCreate", () => {
  const cfg = DEFAULT_DETECTION_CONFIG

  it("respects the autoCreate switch", () => {
    expect(shouldAutoCreate("a\n".repeat(20), "code", { ...cfg, autoCreate: false })).toBe(false)
  })

  it("respects the enabledTypes whitelist", () => {
    expect(shouldAutoCreate("a\n".repeat(20), "code", { ...cfg, enabledTypes: ["html"] })).toBe(
      false
    )
  })

  it("requires the configured minLines for code/document", () => {
    expect(shouldAutoCreate("only one line", "code")).toBe(false)
    expect(shouldAutoCreate("a\n".repeat(11), "code")).toBe(true)
  })

  it("auto-creates 'always-create' types with at least 3 lines", () => {
    expect(shouldAutoCreate("a\nb\nc", "html")).toBe(true)
    expect(shouldAutoCreate("a\nb", "html")).toBe(false)
  })
})

describe("detectArtifacts", () => {
  it("marks Cognia Diagram Design HTML with its renderer profile", () => {
    const html = [
      "<!doctype html>",
      '<html><head><meta name="cognia-renderer" content="diagram-design-v1"></head>',
      '<body><svg viewBox="0 0 100 100"></svg></body></html>',
    ].join("\n")
    const out = detectArtifacts(`\`\`\`html\n${html}\n\`\`\``)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: "html", rendererProfile: "diagram-design-v1" })
  })

  it("does not assign a renderer profile to ordinary or unknown-profile HTML", () => {
    const ordinary = detectArtifacts("```html\n<html>\n<body>plain</body>\n</html>\n```")
    const unknown = detectArtifacts(
      '```html\n<html>\n<meta name="cognia-renderer" content="future-v9">\n<body>x</body>\n</html>\n```'
    )
    expect(ordinary[0].rendererProfile).toBeUndefined()
    expect(unknown[0].rendererProfile).toBeUndefined()
  })

  it("returns artifacts only above the line threshold", () => {
    const md = "```js\n" + "a\n".repeat(15) + "```"
    const out = detectArtifacts(md)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("code")
    expect(out[0].lineCount).toBeGreaterThan(10)
  })

  it("captures standalone $$math$$ when long enough", () => {
    const md = "intro\n$$\nline 1\nline 2\nline 3\n$$\nend"
    const out = detectArtifacts(md)
    expect(out.some((a) => a.type === "math")).toBe(true)
  })

  it("respects custom config thresholds", () => {
    const md = "```js\n" + "a\n".repeat(5) + "```"
    expect(detectArtifacts(md)).toEqual([])
    expect(detectArtifacts(md, { ...DEFAULT_DETECTION_CONFIG, minLines: 3 })).toHaveLength(1)
  })
})

describe("getBestArtifact", () => {
  it("returns null for empty input", () => {
    expect(getBestArtifact([])).toBeNull()
  })

  it("returns the highest-confidence/longest artifact", () => {
    const a = {
      type: "code" as const,
      content: "x",
      title: "a",
      startIndex: 0,
      endIndex: 1,
      lineCount: 5,
      confidence: 0.6,
    }
    const b = {
      type: "code" as const,
      content: "y",
      title: "b",
      startIndex: 0,
      endIndex: 1,
      lineCount: 100,
      confidence: 0.9,
    }
    expect(getBestArtifact([a, b])).toBe(b)
  })
})

describe("isCompleteArtifact", () => {
  it("is true for a doctype-bearing HTML payload", () => {
    expect(isCompleteArtifact("<!DOCTYPE html>", "html")).toBe(true)
  })

  it("requires <svg>...</svg> for SVG", () => {
    expect(isCompleteArtifact("<svg></svg>", "svg")).toBe(true)
    expect(isCompleteArtifact("<svg></br>", "svg")).toBe(false)
  })

  it("requires an export for React", () => {
    expect(isCompleteArtifact("export default function A(){}", "react")).toBe(true)
    expect(isCompleteArtifact("function A(){}", "react")).toBe(false)
  })

  it("identifies a Mermaid graph header", () => {
    expect(isCompleteArtifact("graph TD\nA-->B", "mermaid")).toBe(true)
    expect(isCompleteArtifact("nope", "mermaid")).toBe(false)
  })

  it("requires both cells and nbformat for Jupyter", () => {
    expect(isCompleteArtifact('"cells":[],"nbformat":4', "jupyter")).toBe(true)
    expect(isCompleteArtifact('"cells":[]', "jupyter")).toBe(false)
  })

  it("returns true for unspecified types", () => {
    expect(isCompleteArtifact("anything", "code")).toBe(true)
  })
})

describe("module exports", () => {
  it("exposes generateTitle as a re-export of generateArtifactTitle", () => {
    expect(typeof generateTitle).toBe("function")
    expect(generateTitle("export default function Foo(){}", "react")).toBe("Foo")
  })

  it("default export bundles the public API", () => {
    expect(detectorDefault.detectArtifacts).toBe(detectArtifacts)
    expect(detectorDefault.shouldAutoCreate).toBe(shouldAutoCreate)
    expect(detectorDefault.DEFAULT_DETECTION_CONFIG).toBe(DEFAULT_DETECTION_CONFIG)
  })
})

describe("detectStreamingArtifact", () => {
  const openBlock = (lines: number, language = "python") =>
    `Here you go:\n\n\`\`\`${language}\n` +
    Array.from({ length: lines }, (_, index) => `print(${index})`).join("\n")

  it("reports nothing when every fence is already closed", () => {
    expect(detectStreamingArtifact("```python\nprint(1)\n```\nall done")).toBeNull()
  })

  it("reports nothing for a fence that has only just opened", () => {
    expect(detectStreamingArtifact("```python\n")).toBeNull()
  })

  it("waits until the open block clears the same bar auto-create uses", () => {
    // Below `minLines` the sealed block would not become an artifact either, so
    // promising one here would be a lie.
    expect(detectStreamingArtifact(openBlock(3))).toBeNull()
    expect(detectStreamingArtifact(openBlock(12))).not.toBeNull()
  })

  it("describes the block still being written", () => {
    const pending = detectStreamingArtifact(openBlock(12))
    expect(pending?.type).toBe("code")
    expect(pending?.lineCount).toBe(12)
    expect(pending?.title).toBeTruthy()
  })

  it("only considers the trailing unterminated fence", () => {
    const finished = "```js\nconst a = 1\n```\n\nand now the real one:\n\n"
    const pending = detectStreamingArtifact(
      finished + "```python\n" + openBlock(12).split("\n").slice(3).join("\n")
    )
    expect(pending?.type).toBe("code")
    expect(pending?.lineCount).toBe(12)
  })

  it("honours a raised minLines threshold", () => {
    expect(
      detectStreamingArtifact(openBlock(12), { ...DEFAULT_DETECTION_CONFIG, minLines: 50 })
    ).toBeNull()
  })

  it("honours the enabled-types opt-out", () => {
    expect(
      detectStreamingArtifact(openBlock(12), { ...DEFAULT_DETECTION_CONFIG, enabledTypes: ["svg"] })
    ).toBeNull()
  })
})
