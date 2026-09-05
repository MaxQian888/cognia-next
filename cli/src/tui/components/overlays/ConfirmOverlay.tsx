/**
 * A one-step confirm/cancel prompt with a scrollable body preview. Used by
 * `/init` to show a generated/rewritten `AGENTS.md` before overwriting. The body
 * scrolls like {@link DocumentViewer}; Enter confirms, Esc/q cancels.
 *
 * View-only: scroll position lives here; the confirm/cancel decisions are
 * delegated to the parent via callbacks so the App stays a thin interpreter.
 */
import React from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

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
import { contentRows } from "../../layout/terminal-layout"

export interface ConfirmOverlayProps {
  title: string
  body: string
  format: DocumentFormat
  onConfirm: () => void
  onCancel: () => void
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
}

/** Rows reserved for the border, title, and footer chrome. */
const CHROME_ROWS = 6

export function ConfirmOverlay({
  title,
  body,
  format,
  onConfirm,
  onCancel,
  viewportRows,
}: ConfirmOverlayProps) {
  const theme = useTheme()
  const [scroll, setScroll] = React.useState(0)

  const prepared = React.useMemo(
    () => prepareDocumentLines(body, format, undefined, title),
    [body, format, title]
  )
  const total = lineCount(prepared)
  const viewport = Math.max(1, contentRows(viewportRows ?? 24, CHROME_ROWS))

  const move = React.useCallback(
    (delta: number) => setScroll((s) => clampScroll(s + delta, total, viewport)),
    [total, viewport]
  )

  useModalInput((input, key) => {
    // Mouse (fullscreen `scroll` only): the wheel scrolls the preview; other
    // mouse reports are swallowed so the SGR sequence isn't matched as a key.
    const mouse = parseMouseEvent(input)
    if (mouse) {
      if (mouse.kind === "wheel") move(mouse.dir === "up" ? -1 : 1)
      return
    }
    if (key.return) return onConfirm()
    if (key.escape || input === "q") return onCancel()
    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.pageUp || input === "b") return move(-viewport)
    if (key.pageDown || input === " ") return move(viewport)
    if (input === "g") return setScroll(0)
    if (input === "G") return setScroll(maxScroll(total, viewport))
  })

  const start = clampScroll(scroll, total, viewport)
  const end = Math.min(total, start + viewport)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>
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
        {`${positionLabel(start, viewport, total)} · Enter confirm · Esc cancel · ↑/↓ scroll`}
      </Text>
    </Box>
  )
}
