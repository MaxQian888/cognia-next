/**
 * A scrollable, read-only pager for long documents — skill / tool detail and the
 * `/view` file viewer. Markdown bodies render through the Markdown tokenizer;
 * text bodies render verbatim (optionally syntax-highlighted). All scroll math is
 * pure ({@link ../document-view}); this component owns only the viewport size,
 * the scroll offset, and key handling.
 *
 * Keys: ↑/↓ line · PgUp/PgDn or Space/b page · g/G top/bottom · Esc/q/Enter close.
 */
import React from "react"
import { Box, Text, useInput, useStdout } from "ink"

import { MarkdownLine } from "../Markdown"
import { parseMouseEvent } from "../../input/mouse"
import { useTheme } from "../../theme/context"
import {
  clampScroll,
  lineCount,
  maxScroll,
  positionLabel,
  prepareDocumentLines,
} from "../document-view"
import type { DocumentFormat } from "../../state/types"

export interface DocumentViewerProps {
  title: string
  body: string
  format: DocumentFormat
  lang?: string
  onClose: () => void
  /** Copy the complete, unwindowed document (used by `/transcript`). */
  onCopy?: (body: string) => void
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
}

/** Rows reserved for the border, title, and footer chrome. */
const CHROME_ROWS = 6

/** Lines scrolled per mouse-wheel notch. */
const WHEEL_SCROLL_LINES = 3

export function DocumentViewer({
  title,
  body,
  format,
  lang,
  onClose,
  onCopy,
  viewportRows,
}: DocumentViewerProps) {
  const theme = useTheme()
  const { stdout } = useStdout()
  const [scroll, setScroll] = React.useState(0)
  const [searchDraft, setSearchDraft] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState({ query: "", matches: [] as number[], index: 0 })

  const prepared = React.useMemo(
    () => prepareDocumentLines(body, format, lang),
    [body, format, lang]
  )
  const total = lineCount(prepared)
  const viewport =
    viewportRows ?? Math.max(4, ((stdout?.rows as number | undefined) ?? 24) - CHROME_ROWS)

  const move = React.useCallback(
    (delta: number) => setScroll((s) => clampScroll(s + delta, total, viewport)),
    [total, viewport]
  )

  const searchableLines = React.useMemo(
    () =>
      prepared.kind === "text"
        ? prepared.lines
        : prepared.lines.map((line) => {
            if ("spans" in line) return line.spans.map((span) => span.text).join("")
            if (line.kind === "code") return line.text
            if (line.kind === "table") {
              return [line.header, ...line.rows]
                .flatMap((row) => row)
                .flatMap((spans) => spans)
                .map((span) => span.text)
                .join(" ")
            }
            return ""
          }),
    [prepared]
  )

  const commitSearch = React.useCallback(
    (query: string) => {
      const normalized = query.trim().toLowerCase()
      const matches = normalized
        ? searchableLines.flatMap((line, index) =>
            line.toLowerCase().includes(normalized) ? [index] : []
          )
        : []
      setSearch({ query: query.trim(), matches, index: 0 })
      setSearchDraft(null)
      if (matches[0] !== undefined) setScroll(clampScroll(matches[0], total, viewport))
    },
    [searchableLines, total, viewport]
  )

  const moveMatch = React.useCallback(
    (delta: number) => {
      if (search.matches.length === 0) return
      const index = (search.index + delta + search.matches.length) % search.matches.length
      setSearch({ ...search, index })
      setScroll(clampScroll(search.matches[index], total, viewport))
    },
    [search, total, viewport]
  )

  useInput((input, key) => {
    if (searchDraft !== null) {
      if (key.escape) return setSearchDraft(null)
      if (key.return) return commitSearch(searchDraft)
      if (key.backspace || key.delete) return setSearchDraft((value) => value?.slice(0, -1) ?? null)
      if (input && !key.ctrl && !key.meta) return setSearchDraft((value) => (value ?? "") + input)
      return
    }
    if (key.escape || key.return || input === "q") return onClose()
    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.pageUp || input === "b") return move(-viewport)
    if (key.pageDown || input === " ") return move(viewport)
    if (key.ctrl && input === "u") return move(-Math.max(1, Math.floor(viewport / 2)))
    if (key.ctrl && input === "d") return move(Math.max(1, Math.floor(viewport / 2)))
    if (input === "g") return setScroll(0)
    if (input === "G") return setScroll(maxScroll(total, viewport))
    if (input === "/") return setSearchDraft("")
    if (input === "n") return moveMatch(1)
    if (input === "N") return moveMatch(-1)
    if (input === "y" && onCopy) return onCopy(body)
    // Mouse wheel (SGR tracking is on in fullscreen): scroll a few lines per
    // notch; other mouse events are swallowed so they don't fall through.
    const mouse = parseMouseEvent(input)
    if (mouse) {
      if (mouse.kind === "wheel")
        move(mouse.dir === "up" ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES)
      return
    }
  })

  const start = clampScroll(scroll, total, viewport)
  const end = Math.min(total, start + viewport)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      <Box flexDirection="column">
        {prepared.kind === "markdown"
          ? prepared.lines
              .slice(start, end)
              .map((line, i) => <MarkdownLine key={start + i} line={line} />)
          : prepared.lines
              .slice(start, end)
              .map((line, i) => <Text key={start + i}>{line.length > 0 ? line : " "}</Text>)}
      </Box>
      <Text color={theme.muted} dimColor>
        {searchDraft !== null
          ? `/${searchDraft}█ · enter search · esc cancel`
          : `${positionLabel(start, viewport, total)}${search.query ? ` · ${search.matches.length === 0 ? "0" : search.index + 1}/${search.matches.length} matches` : ""} · ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · / search · n/N next/prev${onCopy ? " · y copy all" : ""} · q/esc close`}
      </Text>
    </Box>
  )
}
