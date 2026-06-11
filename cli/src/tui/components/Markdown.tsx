/**
 * Renders markdown text to Ink elements: headings, paragraphs, fenced code
 * (syntax-highlighted), blockquotes, lists, and rules. The tokenizing/​
 * highlighting logic is pure (`markdown/*`); this component only maps the
 * resulting lines to `<Text>`.
 */
import React from "react"
import { Box, Text } from "ink"

import { highlightCode } from "../markdown/highlight"
import { tokenizeMarkdown } from "../markdown/tokenize"
import { stringWidth } from "../markdown/width"
import type { MdLine, MdSpan, TableAlign } from "../markdown/types"

function Span({ span }: { span: MdSpan }) {
  if (span.code) {
    return <Text color="yellow">{span.text}</Text>
  }
  if (span.link) {
    return (
      <Text color="blue" underline bold={span.bold} italic={span.italic}>
        {span.text}
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
            {c > 0 ? <Text color="gray">{" │ "}</Text> : null}
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
      <Text color="gray">{sep}</Text>
      {line.rows.map((row, i) => (
        <React.Fragment key={i}>{renderRow(row, false)}</React.Fragment>
      ))}
    </Box>
  )
}

export function MarkdownLine({ line }: { line: MdLine }) {
  switch (line.kind) {
    case "heading":
      // Render the level marker and the inline spans as sibling <Text> nodes.
      // Mixing a raw string ("### ") directly with the styled span array inside
      // one colored <Text> could drop the heading's inline content in some
      // terminals; an all-element child list renders reliably.
      return (
        <Text bold color="cyan">
          <Text>{"#".repeat(line.level)} </Text>
          {spansText(line.spans)}
        </Text>
      )
    case "paragraph":
      return <Text>{spansText(line.spans)}</Text>
    case "code":
      return <Text>{"  " + highlightCode(line.text, line.lang)}</Text>
    case "blockquote":
      return (
        <Text color="gray" dimColor>
          {"│ "}
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
            <Text color={line.checked ? "green" : undefined}>{line.checked ? "☑" : "☐"}</Text>{" "}
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
      return <Text color="gray">────────</Text>
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
