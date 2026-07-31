import React from "react"
import { render } from "@testing-library/react"

import {
  Markdown,
  codeFrameWidth,
  cellRefText,
  collectTableFootnotes,
  truncateToWidth,
} from "./Markdown"
import type { MdLine } from "../markdown/types"

describe("Markdown", () => {
  it("renders headings, emphasis, code spans and links", () => {
    const { container } = render(<Markdown raw={"# Title\n\na **b** `c` [d](http://x) ~~e~~"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Title")
    expect(text).toContain("b")
    expect(text).toContain("c")
    expect(text).toContain("d")
    expect(text).toContain("e")
  })

  it("renders inline content (code + bold) inside a level-3 heading", () => {
    const { container } = render(<Markdown raw={"### Status `ok` and **done**"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Status")
    expect(text).toContain("ok")
    expect(text).toContain("done")
  })

  it("renders fenced code, blockquotes, lists and rules", () => {
    const { container } = render(
      <Markdown raw={"```ts\nconst x = 1\n```\n\n> quote\n\n- item\n\n---"} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("const x = 1")
    expect(text).toContain("quote")
    expect(text).toContain("item")
  })

  it("frames a fenced code block with a language label and gutter", () => {
    const { container } = render(<Markdown raw={"```ts\nconst x = 1\n```"} />)
    const text = container.textContent ?? ""
    // Top rule carries the language label; body line has the dim gutter; a
    // closing rule terminates the block.
    expect(text).toContain("╭─ ts")
    expect(text).toContain("│ ")
    expect(text).toContain("╰")
  })

  it("labels an unlabeled fence as `code`", () => {
    const { container } = render(<Markdown raw={"```\nplain\n```"} />)
    expect(container.textContent ?? "").toContain("╭─ code")
  })

  it("sizes the code frame to its content width, clamped to [24, 80]", () => {
    expect(codeFrameWidth(undefined)).toBe(24) // floor for empty/short blocks
    expect(codeFrameWidth(1)).toBe(24)
    expect(codeFrameWidth(40)).toBe(42) // content + 2-col gutter
    expect(codeFrameWidth(200)).toBe(80) // capped
  })

  it("clamps the code frame to a narrow terminal width (no overflow wrap)", () => {
    // A narrow terminal caps the frame below the default 80 so the top/bottom
    // rules don't wrap to a second line.
    expect(codeFrameWidth(200, 50)).toBe(50) // terminal cap wins over content
    expect(codeFrameWidth(40, 50)).toBe(42) // content+gutter still under the cap
    expect(codeFrameWidth(200, 200)).toBe(80) // a wide terminal keeps the 80 cap
    expect(codeFrameWidth(10, 10)).toBe(24) // never below the 24 floor
  })

  it("cascades the gutter for a nested blockquote", () => {
    const { container } = render(<Markdown raw={"> > inner"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("inner")
    // Two levels of quote → two stacked gutters.
    expect(text).toContain("│ │ ")
  })

  // Link rendering depends on terminal OSC-8 support, which we pin per test so
  // the result is deterministic regardless of the host terminal running CI.
  const withHyperlinks = (on: boolean, fn: () => void) => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = on ? "1" : "0"
    try {
      fn()
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  }

  it("shows a link's URL in parentheses when the terminal lacks hyperlink support", () => {
    withHyperlinks(false, () => {
      const { container } = render(<Markdown raw={"see [docs](http://x.test/y)"} />)
      const text = container.textContent ?? ""
      expect(text).toContain("docs")
      expect(text).toContain("(http://x.test/y)")
    })
  })

  it("emits an OSC-8 hyperlink (label only, no parens) on a capable terminal", () => {
    withHyperlinks(true, () => {
      const { container } = render(<Markdown raw={"see [docs](http://x.test/y)"} />)
      const text = container.textContent ?? ""
      // OSC-8 wraps the label; the noisy "(url)" suffix is dropped.
      expect(text).toContain("docs")
      expect(text).toContain("http://x.test/y") // present inside the escape
      expect(text).not.toContain("(http://x.test/y)")
      // The OSC-8 opener (ESC ]8;;) is embedded around the label.
      expect(text).toContain("]8;;")
    })
  })

  it("does not duplicate the URL for a bare autolink", () => {
    withHyperlinks(false, () => {
      const { container } = render(<Markdown raw={"<http://x.test/>"} />)
      const text = container.textContent ?? ""
      // The label already is the URL, so no extra parenthesised copy is appended.
      expect(text).not.toContain("(http://x.test/)")
    })
  })

  it("differentiates heading levels (markers retained, incl. h4–h6)", () => {
    const { container } = render(
      <Markdown raw={"# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6"} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("# H1")
    expect(text).toContain("## H2")
    expect(text).toContain("### H3")
    expect(text).toContain("#### H4")
    expect(text).toContain("##### H5")
    expect(text).toContain("###### H6")
  })

  it("renders an empty document without crashing", () => {
    const { container } = render(<Markdown raw="" />)
    expect(container.textContent).toBe("")
  })

  it("renders a GFM table with its header and cell values", () => {
    const src = ["| Name | Age |", "| --- | --- |", "| Ann | 30 |", "| Bob | 25 |"].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Name")
    expect(text).toContain("Age")
    expect(text).toContain("Ann")
    expect(text).toContain("30")
    expect(text).toContain("Bob")
    // Column separator + header rule are drawn.
    expect(text).toContain("│")
    expect(text).toContain("─")
  })

  it("pads center- and right-aligned table columns", () => {
    const src = [
      "| L | C | R |",
      "| :-- | :-: | --: |",
      "| a | bb | ccc |",
      "| aaaa | b | c |",
    ].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("a")
    expect(text).toContain("bb")
    expect(text).toContain("ccc")
    // The short right-aligned cell "c" gets leading padding to the column width.
    expect(text).toContain("  c")
  })

  it("aligns a table column whose cells contain CJK text", () => {
    // "模型" is 4 display columns; the ASCII header "Model" is 5. The narrower
    // CJK cell must be right-padded by the wide-aware width so the next column
    // still lines up — assert the separator follows the padded cell.
    const src = ["| Model | Note |", "| --- | --- |", "| 模型 | ok |"].join("\n")
    const { container } = render(<Markdown raw={src} />)
    const text = container.textContent ?? ""
    expect(text).toContain("模型")
    // The 4-wide cell is padded by 1 to the 5-wide "Model" column, then the
    // " │ " separator — so 2 spaces total. Without CJK-aware width it would be
    // padded by 3 (treating "模型" as 2 chars), leaving a ragged column.
    expect(text).toContain("模型  │")
    expect(text).not.toContain("模型   │")
  })

  it("renders GFM task-list checkboxes", () => {
    const { container } = render(<Markdown raw={"- [x] shipped\n- [ ] pending"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("☑")
    expect(text).toContain("shipped")
    expect(text).toContain("☐")
    expect(text).toContain("pending")
  })

  it("draws a horizontal rule across the available width (not a fixed stub)", () => {
    const { container } = render(<Markdown raw={"---"} />)
    const text = container.textContent ?? ""
    // No terminal columns in the test env → the default 24-col rule, which is
    // wider than the old fixed 8-dash stub.
    expect(text).toContain("─".repeat(24))
  })

  it("renders inline code with the themed foreground (background optional)", () => {
    const { container } = render(<Markdown raw={"use `npm run dev`"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("npm run dev")
  })

  it("keeps nested list items and their markers (hanging-indent layout)", () => {
    const { container } = render(<Markdown raw={"- top\n  - nested\n- back"} />)
    const text = container.textContent ?? ""
    expect(text).toContain("top")
    expect(text).toContain("nested")
    expect(text).toContain("back")
    // Bullet markers survive the Box-based indent.
    expect(text).toContain("•")
  })

  it("footnotes table links so the URL doesn't misalign the column", () => {
    // Without OSC-8 support, a link cell would otherwise render `label (url)`
    // and break column alignment; instead the URL is referenced as `[1]` and
    // listed below the table.
    withHyperlinks(false, () => {
      const src = ["| Site | Note |", "| --- | --- |", "| [Home](http://x.test/p) | ok |"].join(
        "\n"
      )
      const { container } = render(<Markdown raw={src} />)
      const text = container.textContent ?? ""
      expect(text).toContain("Home[1]")
      expect(text).toContain("[1] http://x.test/p")
      // The inline parenthesised URL is gone.
      expect(text).not.toContain("(http://x.test/p)")
    })
  })

  it("does not footnote links when the terminal supports OSC-8 hyperlinks", () => {
    withHyperlinks(true, () => {
      const src = ["| Site |", "| --- |", "| [Home](http://x.test/p) |"].join("\n")
      const { container } = render(<Markdown raw={src} />)
      const text = container.textContent ?? ""
      expect(text).toContain("Home")
      // No footnote reference list — the label is clickable inline.
      expect(text).not.toContain("[1] http://x.test/p")
    })
  })
})

describe("table helpers", () => {
  const tableLine = (cell: MdLine): Extract<MdLine, { kind: "table" }> =>
    cell as Extract<MdLine, { kind: "table" }>

  it("collectTableFootnotes gathers distinct off-label URLs (only without OSC-8)", () => {
    const line = tableLine({
      kind: "table",
      header: [[{ text: "h" }]],
      rows: [
        [[{ text: "a", link: "http://x/1" }]],
        [[{ text: "b", link: "http://x/1" }]], // duplicate URL → one entry
        [[{ text: "http://x/2", link: "http://x/2" }]], // label == url → skipped
      ],
      align: [null],
    })
    expect(collectTableFootnotes(line, false)).toEqual(["http://x/1"])
    expect(collectTableFootnotes(line, true)).toEqual([])
  })

  it("cellRefText renders footnoted links as label[n]", () => {
    const spans = [{ text: "see " }, { text: "here", link: "http://x/1" }]
    expect(cellRefText(spans, ["http://x/1"])).toBe("see here[1]")
    // Not in the footnote list → plain label.
    expect(cellRefText(spans, [])).toBe("see here")
  })

  it("truncateToWidth cuts to width with an ellipsis, CJK-aware", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello")
    expect(truncateToWidth("hello world", 6)).toBe("hello…")
    // Each CJK glyph is two columns: width 4 fits one glyph + ellipsis.
    expect(truncateToWidth("模型名称", 3)).toBe("模…")
  })
})
