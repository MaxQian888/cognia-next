/**
 * Interactive plugin-marketplace browser overlay: a live search box + section
 * tabs over the fetched catalog, with install-state badges and in-place actions.
 * Owns its query/section/highlight locally (like the historySearch overlay) and
 * reuses `windowList` + `OverlayFooter`; the parent supplies the (already
 * install-annotated) entries and routes the chosen action.
 *
 * Keys: type to filter · Backspace edits · Tab cycles section · ↑/↓ move ·
 * Enter installs (or opens detail if installed) · Ctrl+E enable/disable ·
 * Ctrl+U update · Ctrl+X uninstall · Esc closes. Single letters stay free for
 * typeahead, so actions use Ctrl-combos (same convention as the Skills panel).
 * Rows are clickable (fullscreen `scroll` mode): a click runs the primary action.
 */
import React, { useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import type { DOMElement } from "ink"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import {
  entryHint,
  filterMarketplace,
  nextSection,
  MARKETPLACE_SECTIONS,
  type MarketplaceAction,
  type MarketplaceBrowseEntry,
  type MarketplaceSection,
} from "../runtime/marketplace-filter"

const DEFAULT_MAX_ROWS = 8
// Header rows above the list: title + section tabs + search line.
const HEADER_ROWS = 3

/** The action Enter / a click runs on an entry. */
function primaryAction(e: MarketplaceBrowseEntry): MarketplaceAction {
  return e.installed ? "show" : "install"
}

/** Footer hint, tailored to whether the highlighted entry is installed. */
function footerHint(e: MarketplaceBrowseEntry | undefined): string {
  if (e?.installed) {
    const toggle = e.enabled === false ? "Ctrl+E enable" : "Ctrl+E disable"
    const update = e.updatable ? " · Ctrl+U update" : ""
    return `Enter detail · ${toggle}${update} · Ctrl+X uninstall · Tab section · Esc close`
  }
  return "Enter install · type search · Tab section · ↑/↓ move · Esc close"
}

export function MarketplaceBrowser({
  entries,
  onAction,
  onCancel,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: {
  entries: MarketplaceBrowseEntry[]
  /** Run the chosen action on an entry (install/show/enable/disable/update/uninstall). */
  onAction: (entry: MarketplaceBrowseEntry, action: MarketplaceAction) => void
  onCancel: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [section, setSection] = useState<MarketplaceSection>("all")
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const filtered = filterMarketplace(entries, query, section)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0
  const current = filtered[safeIndex]

  const win = windowList(filtered.length, safeIndex, maxRows)
  const visible = filtered.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` only): a click runs the row's primary action.
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: HEADER_ROWS,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = filtered[win.start + offset]
      if (target) {
        setIndex(win.start + offset)
        onAction(target, primaryAction(target))
      }
    },
    onWheel: (dir) =>
      setIndex((i) =>
        dir === "up"
          ? Math.max(0, Math.min(i, filtered.length - 1) - 1)
          : Math.min(filtered.length - 1, i + 1)
      ),
  })

  useInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) {
        if (query) {
          setQuery("")
          setIndex(0)
        } else onCancel()
        return
      }
      if (key.return) {
        if (current) onAction(current, primaryAction(current))
        return
      }
      // Ctrl-combo actions on the highlighted entry (single letters stay free
      // for typeahead). Enable/disable toggles by current state.
      if (key.ctrl && (input === "e" || input === "E")) {
        if (current?.installed) onAction(current, current.enabled === false ? "enable" : "disable")
        return
      }
      if (key.ctrl && (input === "u" || input === "U")) {
        if (current?.installed && current.updatable) onAction(current, "update")
        return
      }
      if (key.ctrl && (input === "x" || input === "X")) {
        if (current?.installed) onAction(current, "uninstall")
        return
      }
      if (key.tab) {
        setSection((s) => nextSection(s))
        setIndex(0)
        return
      }
      if (key.upArrow) {
        setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1))
        return
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(filtered.length - 1, i + 1))
        return
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        setIndex(0)
        return
      }
      if (input && !key.ctrl && !key.meta && !isMouseSequence(input)) {
        setQuery((q) => q + input)
        setIndex(0)
      }
    },
    { isActive }
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
      <Text bold>Marketplace · {entries.length} plugins</Text>
      <Text>
        {MARKETPLACE_SECTIONS.map((s, i) => (
          <Text key={s} color={s === section ? theme.accent : theme.muted} bold={s === section}>
            {i > 0 ? "  " : ""}
            {s === section ? `[${s}]` : s}
          </Text>
        ))}
      </Text>
      <Text>
        <Text color={theme.muted}>search: </Text>
        {query ? (
          <Text>{query}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            (all)
          </Text>
        )}
      </Text>
      {filtered.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no matches
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
          ) : null}
          {visible.map((e, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            return (
              <Text key={e.installRef} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                {e.name}
                <Text color={theme.muted}> — {entryHint(e)}</Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={footerHint(current)} />
    </Box>
  )
}
