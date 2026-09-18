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
import { useCliTranslations } from "../../i18n"
import { useModalInput } from "../../input/input-router"

import { markdownLineSpans } from "../../render/cell-terminal-block"
import { ansiToSpans } from "../../render/ansi-spans"
import { wrapTerminalSpans, type TerminalStyle } from "../../render/terminal-block"
import { parseMouseEvent } from "../../input/mouse"
import { useTheme } from "../../theme/context"
import { clampScroll, maxScroll, positionLabel, prepareDocumentLines } from "../document-view"
import type { DocumentFormat } from "../../state/types"
import { contentRows } from "../../layout/terminal-layout"

export interface ConfirmOverlayProps {
  title: string
  body: string
  format: DocumentFormat
  onConfirm: () => void
  onCancel: () => void
  /** Offer a separate explicit action that remembers this acknowledgement. */
  onRemember?: () => void
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
  columns?: number
}

/** Rows reserved for the border, title, and footer chrome. */
const CHROME_ROWS = 6

export function ConfirmOverlay({
  title,
  body,
  format,
  onConfirm,
  onCancel,
  onRemember,
  viewportRows,
  columns = 80,
}: ConfirmOverlayProps) {
  const theme = useTheme()
  const t = useCliTranslations("cliUiApproval")
  const [choice, setChoice] = React.useState(0)
  const [scroll, setScroll] = React.useState(0)

  const prepared = React.useMemo(
    () => prepareDocumentLines(body, format, undefined, title),
    [body, format, title]
  )
  const bodyWidth = Math.max(1, columns - 4)
  const lines = React.useMemo(() => {
    if (prepared.kind === "diff") return prepared.lines
    return wrapTerminalSpans(
      prepared.lines.flatMap((line, index) => [
        ...(index > 0 ? [{ text: "\n", style: "plain" as const }] : []),
        ...(typeof line === "string"
          ? ansiToSpans(line, "plain")
          : markdownLineSpans(line, true, theme, bodyWidth)),
      ]),
      bodyWidth
    )
  }, [prepared, theme, bodyWidth])
  const total = lines.length
  const colors: Record<TerminalStyle, string | undefined> = {
    plain: undefined,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    code: theme.secondary,
  }
  const viewport = Math.max(1, contentRows(viewportRows ?? 24, CHROME_ROWS + (onRemember ? 3 : 0)))

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
    if (key.return) {
      if (onRemember && choice === 1) return onRemember()
      if (onRemember && choice === 2) return onCancel()
      return onConfirm()
    }
    if (key.escape || input === "q") return onCancel()
    if (onRemember && (key.upArrow || key.downArrow)) {
      setChoice((current) => (current + (key.upArrow ? 2 : 1)) % 3)
      return
    }
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      width={columns}
      flexShrink={0}
    >
      <Text bold color={theme.warning} wrap="truncate-end">
        {title}
      </Text>
      <Box flexDirection="column">
        {lines.slice(start, end).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
            {line.plain
              ? line.spans.map((span, j) => (
                  <Text
                    key={j}
                    color={span.color ?? colors[span.style]}
                    bold={span.bold}
                    italic={span.italic}
                    underline={span.underline}
                  >
                    {span.text}
                  </Text>
                ))
              : " "}
          </Text>
        ))}
      </Box>
      {onRemember
        ? (["bypassOnce", "bypassRemember", "bypassCancel"] as const).map((label, index) => (
            <Text
              wrap="truncate-end"
              key={label}
              color={choice === index ? theme.accent : undefined}
              bold={choice === index}
            >
              {choice === index ? "❯ " : "  "}
              {t(label)}
            </Text>
          ))
        : null}
      <Text color={theme.muted} dimColor wrap="truncate-end">
        {`${positionLabel(start, viewport, total)} · ${t(onRemember ? "bypassActions" : "confirmActions")}`}
      </Text>
    </Box>
  )
}
