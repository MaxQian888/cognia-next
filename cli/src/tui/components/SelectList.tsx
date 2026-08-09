/**
 * A controlled keyboard select list: arrow keys move the highlight, Enter
 * selects, Esc cancels. Stateless — the parent owns `index` and reacts to
 * `onMove` / `onSelect` / `onCancel`, so the same primitive backs both
 * reducer-driven overlays and input-local popups.
 */
import React, { useRef } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../input/input-router"

import { useTheme } from "../theme/context"
import { windowList } from "./list-window"
import { windowByWrappedRows } from "./overlay-layout"
import { OverlayFooter } from "./OverlayFooter"
import { usePanelClick } from "../input/use-panel-click"
import { isMouseSequence } from "../input/mouse"

/** Row prefix drawn before every label ("❯ " / "  "), stolen from the wrap width. */
const LIST_ROW_CHROME = 2

export interface SelectItem {
  label: string
  hint?: string
  /**
   * Label colour for the row while it is NOT highlighted (the highlight always
   * wins, so the cursor stays legible). Lets a list mark a row as dangerous —
   * e.g. `/mode`'s `bypassPermissions` — instead of relying on a glyph alone.
   */
  color?: string
}

export function SelectList({
  title,
  items,
  index,
  onMove,
  onSelect,
  onCancel,
  isActive = true,
  maxRows,
  width,
  footerHint,
  query,
  onQueryChange,
  searchRowVisible = true,
  searchPlaceholder,
  emptyHint,
  disableWheel = false,
}: {
  title?: string
  items: SelectItem[]
  index: number
  onMove: (delta: number) => void
  onSelect: (index: number) => void
  onCancel?: () => void
  isActive?: boolean
  /** Cap the number of visible rows; the list scrolls to keep the highlighted
   * row on-screen. Omitted → show every item (the previous behaviour). */
  maxRows?: number
  /** Box width (e.g. terminal columns) so the panel spans the full width. */
  width?: number | string
  /** Override the bottom key-hint line; pass `false` to hide it. Defaults to the
   * shared `↑/↓ navigate · Enter select · Esc cancel`. */
  footerHint?: string | false
  /** Opt-in typeahead search: when `onQueryChange` is supplied, a search line is
   * rendered above the list and printable keys/backspace edit `query`. The parent
   * owns the filtering — it passes the already-filtered `items` — so the list
   * stays a pure presenter. Omit both to keep the plain (non-searchable) list. */
  query?: string
  onQueryChange?: (query: string) => void
  /** Hide the 🔎 row while still accepting typeahead input (lazy search): short
   * lists stay chrome-free, and the row appears the moment the parent sees a
   * non-empty query. Defaults to true (row always shown when searchable). */
  searchRowVisible?: boolean
  /** Placeholder shown on the search line while `query` is empty. */
  searchPlaceholder?: string
  /** Line shown in place of the list when a search filters everything out. */
  emptyHint?: string
  /** Stop the wheel from moving the highlight (it's still swallowed, not inserted
   * as text). Used when the list shares a screen with a taller scrollable body —
   * e.g. the plan-approval overlay — so the wheel scrolls that body instead. */
  disableWheel?: boolean
}) {
  const theme = useTheme()
  const boxRef = useRef<DOMElement | null>(null)

  // Measure the viewport in WRAPPED ROWS, not items. `maxRows` is a row budget,
  // but a long tool name, executable path or install command wraps — so on a
  // narrow terminal a "10 item" window drew more rows than existed and pushed
  // the highlighted row off screen, the exact clipping this cap exists to
  // prevent. Falls back to the item-count window when the width is unknown.
  const rowWidth = typeof width === "number" ? Math.max(1, width - LIST_ROW_CHROME) : 0
  const win =
    maxRows !== undefined && rowWidth > 0
      ? (() => {
          const wrapped = windowByWrappedRows(
            items.map((item) => (item.hint ? `${item.label}  ${item.hint}` : item.label)),
            index,
            maxRows,
            rowWidth
          )
          return {
            start: wrapped.start,
            end: wrapped.start + wrapped.count,
            above: wrapped.above,
            below: wrapped.below,
          }
        })()
      : windowList(items.length, index, maxRows ?? items.length)
  const visible = items.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` mode only): a click on a row both highlights and
  // selects it (Claude-Code parity); the wheel moves the highlight. Header rows
  // above the items = the optional title line + the optional search line.
  const searchRowShown = Boolean(onQueryChange && searchRowVisible)
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: (title ? 1 : 0) + (searchRowShown ? 1 : 0),
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = win.start + offset
      onMove(target - index)
      onSelect(target)
    },
    onWheel: disableWheel ? undefined : (dir) => onMove(dir === "up" ? -1 : 1),
  })

  useModalInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.upArrow) onMove(-1)
      else if (key.downArrow) onMove(1)
      else if (key.return) onSelect(index)
      else if (key.escape) onCancel?.()
      // Typeahead: only when searchable, and only for keys the navigation branch
      // above didn't consume (printable chars, backspace) — arrows/Enter/Esc stay
      // list controls so the highlight and search box never fight over a key.
      else if (onQueryChange) {
        if (key.backspace || key.delete) onQueryChange((query ?? "").slice(0, -1))
        else if (input && !key.ctrl && !key.meta && !key.tab) onQueryChange((query ?? "") + input)
      }
    },
    {
      isActive,
      shouldHandle: (input, key) =>
        isMouseSequence(input) ||
        key.upArrow ||
        key.downArrow ||
        key.return ||
        (key.escape && onCancel !== undefined) ||
        (onQueryChange !== undefined &&
          (key.backspace || key.delete || Boolean(input && !key.ctrl && !key.meta && !key.tab))),
    }
  )

  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      {title ? <Text bold>{title}</Text> : null}
      {searchRowShown ? (
        <Text color={theme.muted}>
          {"🔎 "}
          {query && query.length > 0 ? (
            <Text color={theme.accent}>{query}</Text>
          ) : (
            <Text dimColor>{searchPlaceholder ?? "type to filter"}</Text>
          )}
        </Text>
      ) : null}
      {onQueryChange && items.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {`  ${emptyHint ?? "no matches"}`}
        </Text>
      ) : null}
      {win.above > 0 ? <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((item, i) => {
        const row = win.start + i
        return (
          <Text key={row} color={row === index ? theme.accent : item.color} bold={row === index}>
            {row === index ? "❯ " : "  "}
            {item.label}
            {item.hint ? <Text color={theme.muted}> {item.hint}</Text> : null}
          </Text>
        )
      })}
      {win.below > 0 ? <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text> : null}
      {footerHint === false ? null : <OverlayFooter hint={footerHint || undefined} />}
    </Box>
  )
}
