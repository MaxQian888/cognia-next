/**
 * Renders markdown text to Ink elements: headings, paragraphs, fenced code
 * (syntax-highlighted), blockquotes, lists, and rules. The tokenizing/​
 * highlighting logic is pure (`markdown/*`); this component only maps the
 * resulting lines to `<Text>`.
 */
import React from "react"
import { Box, Text } from "ink"

import { paletteCodeTheme } from "../markdown/highlight"
import {
  highlightCached,
  themeCodeKey,
  tokenizeCached,
  tokenizeTransient,
} from "../markdown/render-cache"
import { truncateToWidth } from "../markdown/width"
import { osc8Link, supportsHyperlinks } from "../markdown/hyperlink"
import { useTheme } from "../theme/context"
import type { MdLine, MdSpan } from "../markdown/types"
import {
  cellRefText,
  collectTableFootnotes,
  fitCell,
  TABLE_FRAME,
  TABLE_RULE_BOTTOM,
  TABLE_RULE_MID,
  TABLE_RULE_TOP,
  tableLayout,
  tableRule,
  type TableRuleEnds,
} from "../markdown/table-layout"
import { sanitizeTerminalText } from "../render/terminal-block"

/** Whether the host terminal renders OSC-8 hyperlinks. Detected once per render
 * tree at the {@link Markdown} root and read by {@link Span} so links become
 * clickable without prop-drilling through every block kind. */
const HyperlinkContext = React.createContext(false)

/** Bounds for the rule drawn around a fenced code block; the actual width is
 * sized to the block's widest line (+2 for the `│ ` gutter), clamped here. */
const CODE_FRAME_MIN = 24
const CODE_FRAME_MAX = 80

/** Width of the frame around a fenced code block, fit to its content width.
 * `maxWidth` caps it to the terminal width so the top/bottom rules never wrap
 * to a second line on a narrow terminal (defaults to the absolute 80-col cap).
 * Exported for direct, deterministic unit testing of the clamp. */
export function codeFrameWidth(
  contentWidth: number | undefined,
  maxWidth: number = CODE_FRAME_MAX
): number {
  const cap = Math.min(CODE_FRAME_MAX, maxWidth)
  return Math.max(CODE_FRAME_MIN, Math.min(cap, (contentWidth ?? 0) + 2))
}

function Span({ span }: { span: MdSpan }) {
  const theme = useTheme()
  const hyperlinks = React.useContext(HyperlinkContext)
  if (span.code) {
    // Inline code is a distinct foreground colour. No background by default
    // (cleaner, more consistent across terminals); a theme may set `inlineCodeBg`
    // to opt into a subtle block.
    return (
      <Text color={theme.inlineCode} backgroundColor={theme.inlineCodeBg}>
        {span.text}
      </Text>
    )
  }
  if (span.link) {
    // On a capable terminal, emit a real OSC-8 hyperlink so the label itself is
    // clickable and the noisy `(url)` suffix is dropped. Otherwise fall back to
    // the underlined label + dimmed URL (suppressed for a bare `<url>` autolink
    // whose text already equals its href).
    if (hyperlinks) {
      return (
        <Text color={theme.link} underline bold={span.bold} italic={span.italic}>
          {osc8Link(span.link, span.text)}
        </Text>
      )
    }
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

// `truncateToWidth` now lives in ../markdown/width (next to `stringWidth`) so the
// tool-detail formatter can share it. `cellRefText` / `collectTableFootnotes`
// moved to ../markdown/table-layout so the fullscreen renderer can lay a table
// out the same way. Both re-exported here for existing importers.
export { truncateToWidth, cellRefText, collectTableFootnotes }

/** Render a table cell's spans, turning footnoted links into `label[n]` so the
 * URL lives below the table instead of widening (and misaligning) the column. */
function TableCellSpans({ spans, footnotes }: { spans: MdSpan[]; footnotes: string[] }) {
  const theme = useTheme()
  if (footnotes.length === 0) return <>{spansText(spans)}</>
  return (
    <>
      {spans.map((s, i) => {
        const ref = s.link ? footnotes.indexOf(s.link) : -1
        if (ref >= 0) {
          return (
            <Text key={i}>
              <Text color={theme.link} underline>
                {s.text}
              </Text>
              <Text color={theme.muted} dimColor>{`[${ref + 1}]`}</Text>
            </Text>
          )
        }
        return <Span key={i} span={s} />
      })}
    </>
  )
}

function Table({
  line,
  maxWidth,
}: {
  line: Extract<MdLine, { kind: "table" }>
  maxWidth?: number
}) {
  const theme = useTheme()
  const hyperlinks = React.useContext(HyperlinkContext)
  const footnotes = collectTableFootnotes(line, hyperlinks)
  const cols = line.header.length
  const { widths, capped } = tableLayout(line, (spans) => cellRefText(spans, footnotes), maxWidth)
  const edge = (
    <Text color={theme.borderSubtle} dimColor>
      {TABLE_FRAME.vertical}
    </Text>
  )
  const renderRow = (cells: MdSpan[][], header: boolean) => (
    <Text>
      {edge}
      {Array.from({ length: cols }, (_, c) => {
        const spans = cells[c] ?? []
        // A capped, over-wide cell falls back to a truncated plain string (it
        // loses inline styling, but only when the table wouldn't otherwise fit).
        const fit = fitCell(cellRefText(spans, footnotes), widths[c], line.align[c] ?? null, capped)
        return (
          <Text key={c}>
            {" "}
            {fit.left}
            {/* The header is the accent colour as well as bold: in a wide table
                the bold weight alone is easy to lose against the body rows. */}
            <Text bold={header} color={header ? theme.accent : undefined}>
              {fit.truncated ? fit.text : <TableCellSpans spans={spans} footnotes={footnotes} />}
            </Text>
            {fit.right} {edge}
          </Text>
        )
      })}
    </Text>
  )
  const rule = (ends: TableRuleEnds) => (
    <Text color={theme.borderSubtle} dimColor>
      {tableRule(widths, ends)}
    </Text>
  )
  return (
    <Box flexDirection="column">
      {/* Fully framed, the way the fenced code block already is. The old layout
          drew a bare `a │ b` grid with one header rule, which read as loose
          columns of prose rather than as a table, and left the first and last
          column with no edge to align against. */}
      {rule(TABLE_RULE_TOP)}
      {renderRow(line.header, true)}
      {rule(TABLE_RULE_MID)}
      {line.rows.map((row, i) => (
        <React.Fragment key={i}>{renderRow(row, false)}</React.Fragment>
      ))}
      {rule(TABLE_RULE_BOTTOM)}
      {footnotes.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {footnotes.map((url, i) => (
            <Text key={i} color={theme.muted} dimColor>
              {`[${i + 1}] ${url}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

export function MarkdownLine({
  line,
  maxWidth,
  topMargin,
}: {
  line: MdLine
  maxWidth?: number
  /** Insert one blank row above this block for vertical rhythm. Set by
   * {@link Markdown} for headings that don't already follow a blank line. */
  topMargin?: boolean
}) {
  const theme = useTheme()
  // Code-block colours/cache key derived once per line (theme is stable, so the
  // memo holds across re-renders); only the `code` case actually reads them.
  const codeHi = React.useMemo(
    () => ({ theme: paletteCodeTheme(theme), key: themeCodeKey(theme) }),
    [theme]
  )
  switch (line.kind) {
    case "heading": {
      // Differentiate all six levels so a long reply's structure reads at a
      // glance: h1 cyan + underline, h2 blue, h3 magenta, all bold; h4 keeps the
      // h3 colour but turns italic; h5/h6 drop to dim muted. The parser already
      // identified this as a heading, so rendering the source `#` marker again
      // makes valid markdown look unparsed in the terminal.
      const color =
        line.level === 1
          ? theme.heading1
          : line.level === 2
            ? theme.heading2
            : line.level <= 4
              ? theme.heading3
              : theme.muted
      return (
        <Box marginTop={topMargin ? 1 : 0}>
          <Text
            bold={line.level <= 4}
            italic={line.level >= 4}
            color={color}
            underline={line.level === 1}
            dimColor={line.level >= 5}
          >
            {spansText(line.spans)}
          </Text>
        </Box>
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
      const frame = codeFrameWidth(line.width, maxWidth)
      const head = `╭─ ${label} `
      const top = head + "─".repeat(Math.max(3, frame - head.length))
      return (
        <Box flexDirection="column">
          {line.first ? (
            <Text color={theme.muted} dimColor>
              {top}
            </Text>
          ) : null}
          {/* Gutter + body in a flex row so a body line too wide for the frame
              wraps under the code (hanging indent) instead of resetting to
              column 0. Highlighting is cached so a stable block is O(1) per
              flush during streaming. */}
          <Box>
            <Text color={theme.muted} dimColor>
              {"│ "}
            </Text>
            <Box flexGrow={1}>
              <Text>{highlightCached(line.text, line.lang, codeHi.theme, codeHi.key)}</Text>
            </Box>
          </Box>
          {line.last ? (
            <Text color={theme.muted} dimColor>
              {"╰" + "─".repeat(frame - 1)}
            </Text>
          ) : null}
        </Box>
      )
    }
    case "blockquote": {
      // Cascade the gutter for nested quotes (`> >` → `│ │ `) and lay the body
      // out in its own flex column so wrapped lines hang under the text, not
      // back at column 0. The quote text is italic secondary (not just dimmed)
      // so it reads as a quotation rather than de-emphasised noise.
      const depth = Math.max(1, line.depth ?? 1)
      return (
        <Box>
          <Text color={theme.blockquote} dimColor>
            {"│ ".repeat(depth)}
          </Text>
          <Box flexGrow={1}>
            <Text color={theme.blockquote} italic>
              {spansText(line.spans)}
            </Text>
          </Box>
        </Box>
      )
    }
    case "listitem": {
      // Indent via a padded Box (not literal spaces) so a wrapped item hangs
      // under its text instead of resetting to column 0. The marker/checkbox
      // sits in a fixed leading column; the body flexes and wraps beside it.
      const pad = (line.depth + 1) * 2
      // GFM task-list items render a checkbox in place of the bullet/number; the
      // done state is dimmed + struck through for a Claude-Code-style checklist.
      if (line.checked !== undefined) {
        return (
          <Box paddingLeft={pad}>
            <Text color={line.checked ? theme.success : undefined}>
              {line.checked ? "☑" : "☐"}{" "}
            </Text>
            <Box flexGrow={1}>
              <Text dimColor={line.checked} strikethrough={line.checked}>
                {spansText(line.spans)}
              </Text>
            </Box>
          </Box>
        )
      }
      return (
        <Box paddingLeft={pad}>
          <Text>{line.marker} </Text>
          <Box flexGrow={1}>
            <Text>{spansText(line.spans)}</Text>
          </Box>
        </Box>
      )
    }
    case "rule": {
      // Span the available width (terminal minus gutter) instead of a fixed stub
      // so the divider reads as a full horizontal rule.
      const width = maxWidth && maxWidth > 0 ? maxWidth : 24
      return <Text color={theme.muted}>{"─".repeat(width)}</Text>
    }
    case "table":
      return <Table line={line} maxWidth={maxWidth} />
    case "blank":
      return <Text> </Text>
    default:
      return null
  }
}

export function Markdown({
  raw,
  streaming = false,
  columns = 80,
}: {
  raw: string
  streaming?: boolean
  columns?: number
}) {
  const safeRaw = React.useMemo(() => sanitizeTerminalText(raw), [raw])
  // The in-flight streaming body grows every paced-reveal tick; route it through
  // a dedicated single-entry cache so its throwaway prefixes never evict the
  // committed transcript cells from the shared LRU.
  const lines = React.useMemo(
    () => (streaming ? tokenizeTransient(safeRaw) : tokenizeCached(safeRaw)),
    [safeRaw, streaming]
  )
  // Root-owned reactive columns keep fenced-code rules from wrapping on resize.
  const maxWidth = columns > 0 ? columns - 2 : undefined
  // Detected once here (env is stable for the session) and shared via context.
  const hyperlinks = React.useMemo(() => supportsHyperlinks(), [])
  return (
    <HyperlinkContext.Provider value={hyperlinks}>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <MarkdownLine
            key={i}
            line={line}
            maxWidth={maxWidth}
            // Give headings breathing room — but only when the source didn't
            // already separate them with a blank line, so spacing never doubles.
            topMargin={line.kind === "heading" && i > 0 && lines[i - 1]?.kind !== "blank"}
          />
        ))}
      </Box>
    </HyperlinkContext.Provider>
  )
}
