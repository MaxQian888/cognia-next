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
  viewportRows,
}: DocumentViewerProps) {
  const theme = useTheme()
  const { stdout } = useStdout()
  const [scroll, setScroll] = React.useState(0)

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

  useInput((input, key) => {
    if (key.escape || key.return || input === "q") return onClose()
    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.pageUp || input === "b") return move(-viewport)
    if (key.pageDown || input === " ") return move(viewport)
    if (input === "g") return setScroll(0)
    if (input === "G") return setScroll(maxScroll(total, viewport))
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
        {`${positionLabel(start, viewport, total)} · ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · q/esc close`}
      </Text>
    </Box>
  )
}
