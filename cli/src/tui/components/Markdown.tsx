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
import type { MdLine, MdSpan } from "../markdown/types"

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

function Line({ line }: { line: MdLine }) {
  switch (line.kind) {
    case "heading":
      return (
        <Text bold color="cyan">
          {"#".repeat(line.level)} {spansText(line.spans)}
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
    case "listitem":
      return (
        <Text>
          {"  ".repeat(line.depth + 1)}
          {line.marker} {spansText(line.spans)}
        </Text>
      )
    case "rule":
      return <Text color="gray">────────</Text>
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
        <Line key={i} line={line} />
      ))}
    </Box>
  )
}
