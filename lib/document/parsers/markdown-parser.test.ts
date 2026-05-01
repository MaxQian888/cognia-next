/**
 * Tests for Markdown Parser
 */

import {
  parseMarkdown,
  markdownToPlainText,
  extractEmbeddableContent,
  extractTaskLists,
  extractMathBlocks,
  extractFootnotes,
  extractAdmonitions,
} from "./markdown-parser"

describe("parseMarkdown", () => {
  describe("frontmatter parsing", () => {
    it("parses frontmatter", () => {
      const content = `---
title: Test Title
date: 2024-01-01
---
# Content`
      const result = parseMarkdown(content)

      expect(result.frontmatter).toBeDefined()
      expect(result.frontmatter?.title).toBe("Test Title")
    })

    it("handles boolean values in frontmatter", () => {
      const content = `---
published: true
draft: false
---
Content`
      const result = parseMarkdown(content)

      expect(result.frontmatter?.published).toBe(true)
      expect(result.frontmatter?.draft).toBe(false)
    })

    it("handles numeric values in frontmatter", () => {
      const content = `---
count: 42
---
Content`
      const result = parseMarkdown(content)

      expect(result.frontmatter?.count).toBe(42)
    })

    it("handles content without frontmatter", () => {
      const content = "# Title\n\nContent"
      const result = parseMarkdown(content)

      expect(result.frontmatter).toBeUndefined()
    })

    it("handles JSON arrays in frontmatter", () => {
      const content = `---
tags: ["tag1", "tag2"]
---
Content`
      const result = parseMarkdown(content)

      expect(result.frontmatter?.tags).toEqual(["tag1", "tag2"])
    })

    it("handles multiline list frontmatter", () => {
      const content = `---
tags:
  - alpha
  - beta
summary: |
  multi
  line
---
Content`
      const result = parseMarkdown(content)

      expect(result.frontmatter?.tags).toEqual(["alpha", "beta"])
      expect(result.frontmatter?.summary).toContain("multi")
    })
  })

  describe("title extraction", () => {
    it("extracts title from first h1", () => {
      const content = "# My Title\n\nContent"
      const result = parseMarkdown(content)

      expect(result.title).toBe("My Title")
    })

    it("prefers frontmatter title over h1", () => {
      const content = `---
title: Frontmatter Title
---
# H1 Title`
      const result = parseMarkdown(content)

      expect(result.title).toBe("Frontmatter Title")
    })

    it("returns undefined when no title", () => {
      const content = "Just some content"
      const result = parseMarkdown(content)

      expect(result.title).toBeUndefined()
    })
  })

  describe("section extraction", () => {
    it("extracts sections from headings", () => {
      const content = `# Title
      
## Section 1
Content 1

## Section 2
Content 2`
      const result = parseMarkdown(content)

      expect(result.sections.length).toBeGreaterThanOrEqual(2)
    })

    it("captures section levels", () => {
      const content = `# H1
## H2
### H3`
      const result = parseMarkdown(content)

      const levels = result.sections.map((s) => s.level)
      expect(levels).toContain(1)
      expect(levels).toContain(2)
      expect(levels).toContain(3)
    })

    it("captures section content", () => {
      const content = `# Title

Some content here.`
      const result = parseMarkdown(content)

      const titleSection = result.sections.find((s) => s.title === "Title")
      expect(titleSection?.content).toContain("Some content here")
    })

    it("handles content without sections", () => {
      const content = "Just plain text without headings"
      const result = parseMarkdown(content)

      expect(result.sections).toHaveLength(0)
    })
  })

  describe("link extraction", () => {
    it("extracts links", () => {
      const content = "Check out [Google](https://google.com) and [GitHub](https://github.com)"
      const result = parseMarkdown(content)

      expect(result.links).toHaveLength(2)
      expect(result.links[0]).toEqual({ text: "Google", url: "https://google.com" })
      expect(result.links[1]).toEqual({ text: "GitHub", url: "https://github.com" })
    })

    it("handles content without links", () => {
      const content = "No links here"
      const result = parseMarkdown(content)

      expect(result.links).toHaveLength(0)
    })

    it("handles relative links", () => {
      const content = "See [docs](./docs/readme.md)"
      const result = parseMarkdown(content)

      expect(result.links[0].url).toBe("./docs/readme.md")
    })
  })

  describe("code block extraction", () => {
    it("extracts code blocks with language", () => {
      const content = "```javascript\nconst x = 1;\n```"
      const result = parseMarkdown(content)

      expect(result.codeBlocks).toHaveLength(1)
      expect(result.codeBlocks[0].language).toBe("javascript")
      expect(result.codeBlocks[0].code).toBe("const x = 1;")
    })

    it("handles code blocks without language", () => {
      const content = "```\ncode here\n```"
      const result = parseMarkdown(content)

      expect(result.codeBlocks[0].language).toBe("text")
    })

    it("extracts multiple code blocks", () => {
      const content = "```js\ncode1\n```\n\n```py\ncode2\n```"
      const result = parseMarkdown(content)

      expect(result.codeBlocks).toHaveLength(2)
    })
  })

  describe("image extraction", () => {
    it("extracts images", () => {
      const content = "![Alt text](https://example.com/image.png)"
      const result = parseMarkdown(content)

      expect(result.images).toHaveLength(1)
      expect(result.images[0]).toEqual({
        alt: "Alt text",
        url: "https://example.com/image.png",
      })
    })

    it("handles images without alt text", () => {
      const content = "![](image.png)"
      const result = parseMarkdown(content)

      expect(result.images[0].alt).toBe("")
    })

    it("handles multiple images", () => {
      const content = "![img1](1.png) and ![img2](2.png)"
      const result = parseMarkdown(content)

      expect(result.images).toHaveLength(2)
    })
  })
})

describe("task list extraction", () => {
  it("extracts unchecked tasks", () => {
    const content = "- [ ] Buy groceries\n- [ ] Clean house"
    const tasks = extractTaskLists(content)

    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toEqual({ text: "Buy groceries", checked: false, line: 1 })
    expect(tasks[1]).toEqual({ text: "Clean house", checked: false, line: 2 })
  })

  it("extracts checked tasks", () => {
    const content = "- [x] Done task\n- [X] Also done"
    const tasks = extractTaskLists(content)

    expect(tasks).toHaveLength(2)
    expect(tasks[0].checked).toBe(true)
    expect(tasks[1].checked).toBe(true)
  })

  it("handles mixed checked/unchecked", () => {
    const content = "- [x] Done\n- [ ] Not done\n- [x] Also done"
    const tasks = extractTaskLists(content)

    expect(tasks).toHaveLength(3)
    expect(tasks[0].checked).toBe(true)
    expect(tasks[1].checked).toBe(false)
    expect(tasks[2].checked).toBe(true)
  })

  it("supports * and + list markers", () => {
    const content = "* [ ] Star item\n+ [ ] Plus item"
    const tasks = extractTaskLists(content)

    expect(tasks).toHaveLength(2)
  })

  it("returns empty array when no tasks", () => {
    const content = "- Regular item\n- Another item"
    const tasks = extractTaskLists(content)

    expect(tasks).toHaveLength(0)
  })

  it("integrates with parseMarkdown", () => {
    const content = "# Tasks\n- [x] Done\n- [ ] Todo"
    const result = parseMarkdown(content)

    expect(result.taskLists).toHaveLength(2)
  })
})

describe("math block extraction", () => {
  it("extracts display math blocks ($$)", () => {
    const content = "$$\nE = mc^2\n$$"
    const blocks = extractMathBlocks(content)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe("E = mc^2")
    expect(blocks[0].displayMode).toBe(true)
  })

  it("extracts inline math ($)", () => {
    const content = "The formula $E = mc^2$ is famous."
    const blocks = extractMathBlocks(content)

    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe("E = mc^2")
    expect(blocks[0].displayMode).toBe(false)
  })

  it("skips currency patterns", () => {
    const content = "It costs $10 and $1.50 per item."
    const blocks = extractMathBlocks(content)

    expect(blocks).toHaveLength(0)
  })

  it("extracts multiple math blocks", () => {
    const content = "$$\na^2 + b^2 = c^2\n$$\n\nInline $x + y$ here.\n\n$$\n\\int_0^1 f(x) dx\n$$"
    const blocks = extractMathBlocks(content)

    const displayBlocks = blocks.filter((b) => b.displayMode)
    const inlineBlocks = blocks.filter((b) => !b.displayMode)
    expect(displayBlocks.length).toBe(2)
    expect(inlineBlocks.length).toBe(1)
  })

  it("integrates with parseMarkdown", () => {
    const content = "# Math\n$$\nx^2\n$$"
    const result = parseMarkdown(content)

    expect(result.mathBlocks.length).toBeGreaterThanOrEqual(1)
  })
})

describe("footnote extraction", () => {
  it("extracts footnotes", () => {
    const content = "Text[^1]\n\n[^1]: This is the footnote."
    const footnotes = extractFootnotes(content)

    expect(footnotes).toHaveLength(1)
    expect(footnotes[0]).toEqual({ id: "1", content: "This is the footnote." })
  })

  it("extracts multiple footnotes", () => {
    const content = "[^a]: First note\n[^b]: Second note"
    const footnotes = extractFootnotes(content)

    expect(footnotes).toHaveLength(2)
    expect(footnotes[0].id).toBe("a")
    expect(footnotes[1].id).toBe("b")
  })

  it("handles named footnotes", () => {
    const content = "[^long-name]: A footnote with a long name."
    const footnotes = extractFootnotes(content)

    expect(footnotes).toHaveLength(1)
    expect(footnotes[0].id).toBe("long-name")
  })

  it("returns empty for no footnotes", () => {
    const content = "No footnotes here."
    const footnotes = extractFootnotes(content)

    expect(footnotes).toHaveLength(0)
  })

  it("integrates with parseMarkdown", () => {
    const content = "Text[^1]\n\n[^1]: Note content"
    const result = parseMarkdown(content)

    expect(result.footnotes).toHaveLength(1)
  })
})

describe("admonition extraction", () => {
  it("extracts GitHub-style admonitions", () => {
    const content = "> [!NOTE]\n> This is a note."
    const admonitions = extractAdmonitions(content)

    expect(admonitions).toHaveLength(1)
    expect(admonitions[0].type).toBe("note")
    expect(admonitions[0].content).toBe("This is a note.")
  })

  it("extracts admonitions with title", () => {
    const content = "> [!WARNING] Be careful\n> Details here."
    const admonitions = extractAdmonitions(content)

    expect(admonitions).toHaveLength(1)
    expect(admonitions[0].type).toBe("warning")
    expect(admonitions[0].title).toBe("Be careful")
  })

  it("extracts multiple admonitions", () => {
    const content = "> [!NOTE]\n> Note content\n\n> [!TIP]\n> Tip content"
    const admonitions = extractAdmonitions(content)

    expect(admonitions).toHaveLength(2)
    expect(admonitions[0].type).toBe("note")
    expect(admonitions[1].type).toBe("tip")
  })

  it("extracts bold-style admonitions", () => {
    const content = "> **Warning:** This is important.\n> More details."
    const admonitions = extractAdmonitions(content)

    expect(admonitions).toHaveLength(1)
    expect(admonitions[0].type).toBe("warning")
    expect(admonitions[0].content).toContain("This is important.")
  })

  it("supports all valid types", () => {
    const types = ["note", "tip", "warning", "caution", "important"]
    for (const type of types) {
      const content = `> [!${type.toUpperCase()}]\n> Content`
      const admonitions = extractAdmonitions(content)
      expect(admonitions).toHaveLength(1)
      expect(admonitions[0].type).toBe(type)
    }
  })

  it("ignores non-admonition blockquotes", () => {
    const content = "> Just a regular quote.\n> Nothing special."
    const admonitions = extractAdmonitions(content)

    expect(admonitions).toHaveLength(0)
  })

  it("integrates with parseMarkdown", () => {
    const content = "# Doc\n\n> [!NOTE]\n> A note"
    const result = parseMarkdown(content)

    expect(result.admonitions).toHaveLength(1)
  })
})

describe("markdownToPlainText", () => {
  it("removes code blocks", () => {
    const content = "Text\n```js\ncode\n```\nMore text"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("```")
    expect(result).not.toContain("code")
  })

  it("removes inline code", () => {
    const content = "Use `console.log` for debugging"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("`")
  })

  it("removes images", () => {
    const content = "See ![image](url.png) here"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("![")
    expect(result).not.toContain("url.png")
  })

  it("converts links to text only", () => {
    const content = "Visit [Google](https://google.com)"
    const result = markdownToPlainText(content)

    expect(result).toContain("Google")
    expect(result).not.toContain("https://")
    expect(result).not.toContain("[")
  })

  it("removes heading markers", () => {
    const content = "# Title\n## Subtitle"
    const result = markdownToPlainText(content)

    expect(result).not.toMatch(/^#/m)
    expect(result).toContain("Title")
    expect(result).toContain("Subtitle")
  })

  it("removes bold formatting", () => {
    const content = "This is **bold** and __also bold__"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("**")
    expect(result).not.toContain("__")
    expect(result).toContain("bold")
  })

  it("removes italic formatting", () => {
    const content = "This is *italic* and _also italic_"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("*")
    expect(result).not.toMatch(/_italic_/)
    expect(result).toContain("italic")
  })

  it("removes blockquotes", () => {
    const content = "> This is a quote"
    const result = markdownToPlainText(content)

    expect(result).not.toContain(">")
    expect(result).toContain("This is a quote")
  })

  it("removes horizontal rules", () => {
    const content = "Above\n---\nBelow"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("---")
  })

  it("removes list markers", () => {
    const content = "- Item 1\n* Item 2\n1. Item 3"
    const result = markdownToPlainText(content)

    expect(result).toContain("Item 1")
    expect(result).toContain("Item 2")
    expect(result).toContain("Item 3")
  })

  it("normalizes excessive newlines", () => {
    const content = "Para 1\n\n\n\nPara 2"
    const result = markdownToPlainText(content)

    expect(result).not.toContain("\n\n\n")
  })
})

describe("extractEmbeddableContent", () => {
  it("removes frontmatter", () => {
    const content = `---
title: Test
---
Actual content`
    const result = extractEmbeddableContent(content)

    expect(result).not.toContain("---")
    expect(result).not.toContain("title:")
    expect(result).toContain("Actual content")
  })

  it("removes markdown formatting", () => {
    const content = "# Title\n\n**Bold** and [link](url)"
    const result = extractEmbeddableContent(content)

    expect(result).not.toContain("#")
    expect(result).not.toContain("**")
    expect(result).not.toContain("[")
    expect(result).toContain("Title")
    expect(result).toContain("Bold")
    expect(result).toContain("link")
  })

  it("returns clean text suitable for embedding", () => {
    const content = `---
title: Test
---
# Heading

Some **bold** text with [a link](url).

\`\`\`js
code
\`\`\``
    const result = extractEmbeddableContent(content)

    expect(result).toContain("Heading")
    expect(result).toContain("bold")
    expect(result).toContain("a link")
    expect(result).not.toContain("```")
  })
})
