/**
 * Renders markdown text to Ink elements: headings, paragraphs, fenced code
 * (syntax-highlighted), blockquotes, lists, and rules. The tokenizing/​
 * highlighting logic is pure (`markdown/*`); this component only maps the
 * resulting lines to `<Text>`.
 */
import React from "react"
import { Box, Text } from "ink"

import { highlightCode, paletteCodeTheme } from "../markdown/highlight"
import { tokenizeMarkdown } from "../markdown/tokenize"
import { stringWidth } from "../markdown/width"
import { useTheme } from "../theme/context"
import type { MdLine, MdSpan, TableAlign } from "../markdown/types"

/** Bounds for the rule drawn around a fenced code block; the actual width is
 * sized to the block's widest line (+2 for the `│ ` gutter), clamped here. */
const CODE_FRAME_MIN = 24
const CODE_FRAME_MAX = 80

/** Width of the frame around a fenced code block, fit to its content width.
 * Exported for direct, deterministic unit testing of the clamp. */
export function codeFrameWidth(contentWidth: number | undefined): number {
  return Math.max(CODE_FRAME_MIN, Math.min(CODE_FRAME_MAX, (contentWidth ?? 0) + 2))
}

function Span({ span }: { span: MdSpan }) {
  const theme = useTheme()
  if (span.code) {
    return <Text color={theme.inlineCode}>{span.text}</Text>
  }
  if (span.link) {
    // Show the underlined label, then the raw URL dimmed in parens when it adds
    // information the label doesn't already carry (a bare `<url>` autolink has
    // text === href, so the suffix is suppressed to avoid printing it twice).
    const showUrl = Boolean(span.link) && span.link !== span.text
    return (
      <Text>
        <Text color={theme.link} underline bold={span.bold} italic={span.italic}>
          {span.text}
        </Text>
        {showUrl ? (
          <Text color={theme.muted} dimColor>
            {" ("}
            {span.link}
            {")"}
          </Text>
        ) : null}
      </Text>
    )
  }
  return (
    <Text bold={span.bold} italic={span.italic} strikethrough={span.strike}>
      {span.text}
    </Text>
  )
}

function spansText(spans: MdSpan[]): React.ReactNode {
  return spans.map((s, i) => <Span key={i} span={s} />)
}

/** Terminal display width of a cell's spans, for column alignment. Counts CJK /
 * wide glyphs as two columns so tables with Chinese cells line up. */
function cellWidth(spans: MdSpan[]): number {
  return spans.reduce((n, s) => n + stringWidth(s.text), 0)
}

/** Left/right padding strings to set a cell of `used` width into `width` per its
 * column alignment. `used`/`width` are display columns (see {@link cellWidth}). */
function padding(used: number, width: number, align: TableAlign): { left: string; right: string } {
  const gap = Math.max(0, width - used)
  if (align === "right") return { left: " ".repeat(gap), right: "" }
  if (align === "center") {
    const left = Math.floor(gap / 2)
    return { left: " ".repeat(left), right: " ".repeat(gap - left) }
  }
  return { left: "", right: " ".repeat(gap) }
}

function Table({ line }: { line: Extract<MdLine, { kind: "table" }> }) {
  const theme = useTheme()
  const cols = line.header.length
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = cellWidth(line.header[c] ?? [])
    for (const row of line.rows) w = Math.max(w, cellWidth(row[c] ?? []))
    widths[c] = w
  }
  const renderRow = (cells: MdSpan[][], bold: boolean) => (
    <Text>
      {Array.from({ length: cols }, (_, c) => {
        const spans = cells[c] ?? []
        const { left, right } = padding(cellWidth(spans), widths[c], line.align[c] ?? null)
        return (
          <Text key={c}>
            {c > 0 ? <Text color={theme.muted}>{" │ "}</Text> : null}
            {left}
            <Text bold={bold}>{spansText(spans)}</Text>
            {right}
          </Text>
        )
      })}
    </Text>
  )
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─")
  return (
    <Box flexDirection="column">
      {renderRow(line.header, true)}
      <Text color={theme.muted}>{sep}</Text>
      {line.rows.map((row, i) => (
        <React.Fragment key={i}>{renderRow(row, false)}</React.Fragment>
      ))}
    </Box>
  )
}

export function MarkdownLine({ line }: { line: MdLine }) {
  const theme = useTheme()
  switch (line.kind) {
    case "heading": {
      // Render the level marker and the inline spans as sibling <Text> nodes.
      // Mixing a raw string ("### ") directly with the styled span array inside
      // one colored <Text> could drop the heading's inline content in some
      // terminals; an all-element child list renders reliably.
      //
      // Differentiate the hierarchy by colour (and underline the document title)
      // so a long reply's structure reads at a glance: h1 cyan + underline, h2
      // blue, h3+ magenta. The `#` markers are dimmed so the text dominates.
      const color =
        line.level === 1 ? theme.heading1 : line.level === 2 ? theme.heading2 : theme.heading3
      return (
        <Text bold color={color} underline={line.level === 1}>
          <Text dimColor>{"#".repeat(line.level)} </Text>
          {spansText(line.spans)}
        </Text>
      )
    }
    case "paragraph":
      return <Text>{spansText(line.spans)}</Text>
    case "code": {
      // Frame the fenced block: a top rule labelled with the language, a dim
      // left gutter on each body line, and a closing rule — so code stands out
      // from prose the way it does in OpenCode / Claude Code. The rules are only
      // drawn on the block's boundary lines (flagged by the tokenizer).
      const label = line.lang || "code"
      const frame = codeFrameWidth(line.width)
      const head = `╭─ ${label} `
      const top = head + "─".repeat(Math.max(3, frame - head.length))
      return (
        <Box flexDirection="column">
          {line.first ? (
            <Text color={theme.muted} dimColor>
              {top}
            </Text>
          ) : null}
          <Text>
            <Text color={theme.muted} dimColor>
              {"│ "}
            </Text>
            {highlightCode(line.text, line.lang, paletteCodeTheme(theme))}
          </Text>
          {line.last ? (
            <Text color={theme.muted} dimColor>
              {"╰" + "─".repeat(frame - 1)}
            </Text>
          ) : null}
        </Box>
      )
    }
    case "blockquote":
      // Cascade the gutter for nested quotes: `> >` → `│ │ `.
      return (
        <Text color={theme.muted} dimColor>
          {"│ ".repeat(Math.max(1, line.depth ?? 1))}
          {spansText(line.spans)}
        </Text>
      )
    case "listitem": {
      // GFM task-list items render a checkbox in place of the bullet/number; the
      // done state is dimmed + struck through for a Claude-Code-style checklist.
      if (line.checked !== undefined) {
        return (
          <Text>
            {"  ".repeat(line.depth + 1)}
            <Text color={line.checked ? theme.success : undefined}>
              {line.checked ? "☑" : "☐"}
            </Text>{" "}
            <Text dimColor={line.checked} strikethrough={line.checked}>
              {spansText(line.spans)}
            </Text>
          </Text>
        )
      }
      return (
        <Text>
          {"  ".repeat(line.depth + 1)}
          {line.marker} {spansText(line.spans)}
        </Text>
      )
    }
    case "rule":
      return <Text color={theme.muted}>────────</Text>
    case "table":
      return <Table line={line} />
    case "blank":
      return <Text> </Text>
    default:
      return null
  }
}

export function Markdown({ raw }: { raw: string }) {
  const lines = React.useMemo(() => tokenizeMarkdown(raw), [raw])
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <MarkdownLine key={i} line={line} />
      ))}
    </Box>
  )
}
