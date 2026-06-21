/**
 * Interactive plugin-marketplace browser overlay: a live search box + section
 * tabs over the fetched catalog. Owns its query/section/highlight locally (like
 * the historySearch overlay) and reuses `windowList` + `OverlayFooter`; the
 * parent only supplies the cached entries and the select/cancel callbacks.
 *
 * Keys: type to filter · Backspace edits · Tab cycles section · ↑/↓ move ·
 * Enter previews the highlighted entry · Esc closes.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import {
  entryHint,
  filterMarketplace,
  nextSection,
  MARKETPLACE_SECTIONS,
  type MarketplaceBrowseEntry,
  type MarketplaceSection,
} from "../runtime/marketplace-filter"

const DEFAULT_MAX_ROWS = 8
const FOOTER_HINT = "type to search · Tab section · ↑/↓ move · Enter preview · Esc close"

export function MarketplaceBrowser({
  entries,
  onSelect,
  onCancel,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: {
  entries: MarketplaceBrowseEntry[]
  /** Called with the highlighted entry's install ref on Enter. */
  onSelect: (installRef: string) => void
  onCancel: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [section, setSection] = useState<MarketplaceSection>("all")
  const [index, setIndex] = useState(0)

  const filtered = filterMarketplace(entries, query, section)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0

  useInput(
    (input, key) => {
      if (key.escape) return onCancel()
      if (key.return) {
        const e = filtered[safeIndex]
        if (e) onSelect(e.installRef)
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

  const win = windowList(filtered.length, safeIndex, maxRows)
  const visible = filtered.slice(win.start, win.end)

  return (
    <Box
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
      <OverlayFooter hint={FOOTER_HINT} />
    </Box>
  )
}
