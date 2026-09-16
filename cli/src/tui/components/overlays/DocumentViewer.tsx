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
import { Box, Text } from "ink"
import { useCliTranslations } from "../../i18n"
import { useModalInput } from "../../input/input-router"

import { markdownLineSpans } from "../../render/cell-terminal-block"
import { ansiToSpans } from "../../render/ansi-spans"
import { wrapTerminalSpans, type TerminalStyle } from "../../render/terminal-block"
import { parseMouseEvent } from "../../input/mouse"
import { useScreenReader } from "../../render/context"
import { useTheme } from "../../theme/context"
import { clampScroll, maxScroll, positionLabel, prepareDocumentLines } from "../document-view"
import type { PatchLayout, PatchSectionInput } from "../patch-view"
import type { DocumentFormat } from "../../state/types"
import { contentRows } from "../../layout/terminal-layout"

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
  columns?: number
  /** Whether this pane owns keyboard navigation in a split view. */
  focused?: boolean
  /** `format: "diff"` only: labelled patch bodies (e.g. staged vs unstaged). */
  diffSections?: PatchSectionInput[]
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
  columns = 80,
  focused,
  diffSections,
}: DocumentViewerProps) {
  const theme = useTheme()
  const screenReader = useScreenReader()
  const t = useCliTranslations("cliUiDiff")
  const isDiff = format === "diff" && !screenReader
  const [scroll, setScroll] = React.useState(0)
  // The hunk the user last jumped to with [/]. Null means "derive the position
  // from the scroll offset" — needed because a short last hunk can never reach
  // the top row, so scroll alone cannot tell it apart from the previous one.
  const [hunkIndex, setHunkIndex] = React.useState<number | null>(null)
  const [layout, setLayout] = React.useState<PatchLayout>("unified")
  const [searchDraft, setSearchDraft] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState({ query: "", matches: [] as number[], index: 0 })

  const width = Math.max(5, Math.floor(columns) - 1)
  const bodyWidth = Math.max(1, width - 4)
  const prepared = React.useMemo(
    () =>
      isDiff
        ? prepareDocumentLines(body, "diff", lang, title, {
            sections: diffSections,
            layout,
            width: bodyWidth,
            palette: theme,
            translate: t,
          })
        : prepareDocumentLines(body, format === "diff" ? "text" : format, lang, title),
    [body, format, lang, title, isDiff, diffSections, layout, bodyWidth, theme, t]
  )
  const lines = React.useMemo(() => {
    if (prepared.kind === "diff") return prepared.lines
    const spans = prepared.lines.flatMap((line, index) => [
      ...(index > 0 ? [{ text: "\n", style: "plain" as const }] : []),
      ...(typeof line === "string"
        ? ansiToSpans(line, "plain")
        : markdownLineSpans(line, true, theme, bodyWidth)),
    ])
    return wrapTerminalSpans(spans, bodyWidth)
  }, [prepared, theme, bodyWidth])
  const hunkRows = React.useMemo(
    () => (prepared.kind === "diff" ? prepared.hunkRows : []),
    [prepared]
  )
  const total = lines.length
  const viewport = Math.max(1, contentRows(viewportRows ?? 24, CHROME_ROWS))

  // Any scroll that isn't a [/] hunk jump drops the remembered hunk index so
  // the position falls back to the top-anchored derivation.
  const scrollTo = React.useCallback((next: number) => {
    setHunkIndex(null)
    setScroll(next)
  }, [])

  const move = React.useCallback(
    (delta: number) => {
      setHunkIndex(null)
      setScroll((s) => clampScroll(s + delta, total, viewport))
    },
    [total, viewport]
  )

  const searchableLines = React.useMemo(() => lines.map((line) => line.plain), [lines])

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
      if (matches[0] !== undefined) scrollTo(clampScroll(matches[0], total, viewport))
    },
    [searchableLines, scrollTo, total, viewport]
  )

  const moveMatch = React.useCallback(
    (delta: number) => {
      if (search.matches.length === 0) return
      const index = (search.index + delta + search.matches.length) % search.matches.length
      setSearch({ ...search, index })
      scrollTo(clampScroll(search.matches[index], total, viewport))
    },
    [search, scrollTo, total, viewport]
  )

  const jumpHunk = React.useCallback(
    (delta: number) => {
      if (hunkRows.length === 0) return
      const current = hunkIndex ?? hunkRows.reduce((acc, row, i) => (row <= scroll ? i : acc), -1)
      const target = Math.max(0, Math.min(hunkRows.length - 1, current + delta))
      setHunkIndex(target)
      setScroll(clampScroll(hunkRows[target], total, viewport))
    },
    [hunkIndex, hunkRows, scroll, total, viewport]
  )

  // Switching unified/split re-flows every row, so the current scroll offset
  // would point at unrelated lines. Prepare the target layout synchronously
  // (the renderer is pure) and re-anchor on the hunk under review.
  const toggleLayout = React.useCallback(() => {
    const nextLayout = layout === "unified" ? "split" : "unified"
    const anchor = hunkIndex ?? hunkRows.reduce((acc, row, i) => (row <= scroll ? i : acc), -1)
    setLayout(nextLayout)
    if (!isDiff || anchor < 0) return
    const next = prepareDocumentLines(body, "diff", lang, title, {
      sections: diffSections,
      layout: nextLayout,
      width: bodyWidth,
      palette: theme,
      translate: t,
    })
    if (next.kind !== "diff" || next.hunkRows.length === 0) return
    const target = Math.min(anchor, next.hunkRows.length - 1)
    setHunkIndex(target)
    setScroll(clampScroll(next.hunkRows[target], next.lines.length, viewport))
  }, [
    layout,
    isDiff,
    hunkIndex,
    hunkRows,
    scroll,
    body,
    lang,
    title,
    diffSections,
    bodyWidth,
    theme,
    t,
    viewport,
  ])

  useModalInput((input, key) => {
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
    if (input === "g") return scrollTo(0)
    if (input === "G") return scrollTo(maxScroll(total, viewport))
    if (input === "/") return setSearchDraft("")
    if (input === "n") return moveMatch(1)
    if (input === "N") return moveMatch(-1)
    if (isDiff && input === "[") return jumpHunk(-1)
    if (isDiff && input === "]") return jumpHunk(1)
    if (isDiff && input === "s") return toggleLayout()
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
  const colors: Record<TerminalStyle, string | undefined> = {
    plain: undefined,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    code: theme.secondary,
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={viewportRows ?? 24}
      overflow="hidden"
      borderStyle={screenReader ? undefined : "round"}
      borderColor={
        focused === undefined ? theme.border : focused ? theme.accent : theme.borderSubtle
      }
      paddingX={1}
    >
      <Text bold color={theme.accent} wrap="truncate-end">
        {title}
      </Text>
      <Box flexDirection="column" height={viewport} flexShrink={0}>
        {lines.slice(start, end).map((line, i) => (
          <Text key={start + i} wrap="truncate-end">
            {line.plain
              ? line.spans.map((span, j) => (
                  <Text
                    key={j}
                    color={screenReader ? undefined : (span.color ?? colors[span.style])}
                    backgroundColor={screenReader ? undefined : span.background}
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
      <Text color={theme.muted} dimColor wrap="truncate-end">
        {searchDraft !== null
          ? t("searchDraft", { query: searchDraft, cursor: screenReader ? "" : "█" })
          : [
              total <= viewport ? t("allVisible") : positionLabel(start, viewport, total),
              search.query
                ? t("matches", {
                    current: search.matches.length === 0 ? 0 : search.index + 1,
                    total: search.matches.length,
                  })
                : "",
              isDiff && hunkRows.length > 0
                ? t("hunkPosition", {
                    // The jumped-to hunk wins; otherwise the top-anchored one.
                    current:
                      (hunkIndex ??
                        hunkRows.reduce((acc, row, i) => (row <= start ? i : acc), -1)) + 1 || 1,
                    total: hunkRows.length,
                  })
                : "",
              t("viewerNavigation"),
              isDiff ? t("hunkNav") : "",
              isDiff ? t(layout === "unified" ? "splitView" : "unifiedView") : "",
              onCopy ? t("copy") : "",
              t("close"),
            ]
              .filter(Boolean)
              .join(" · ")}
      </Text>
    </Box>
  )
}
