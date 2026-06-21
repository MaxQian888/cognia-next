/**
 * Interactive `/skill` panel: one browsable row per skill with the rich metadata
 * the old flat list hid (origin · category · usage · validation warnings) and an
 * enabled badge. Space toggles a skill for the session, Enter opens its detail
 * pager, Ctrl+N scaffolds a new one, Ctrl+X deletes a custom one. Query/highlight
 * live here; the parent owns the rows and the action callbacks.
 *
 * Keys: type to filter · ↑/↓ move · Space toggle · Enter detail · Ctrl+N new ·
 * Ctrl+X delete · Esc clears the filter, then closes.
 */
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import {
  filterSkillRows,
  skillBadge,
  skillRowHint,
  skillSummary,
  SKILL_PANEL_FOOTER,
  type SkillPanelRow,
} from "../runtime/skill-panel-model"

const DEFAULT_MAX_ROWS = 10

export interface SkillPanelProps {
  rows: SkillPanelRow[]
  onToggle: (id: string) => void
  /** Bulk enable/disable the currently-filtered rows (Ctrl+A / Ctrl+D). */
  onSetAll: (ids: string[], enabled: boolean) => void
  onShow: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onCancel: () => void
  /** Cycle the skill load mode (full ⇄ name-only). Ctrl+T. Optional. */
  onToggleLoadMode?: () => void
  /** Current load mode, shown in the header so the cost trade-off is visible. */
  loadMode?: "full" | "name"
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function SkillPanel({
  rows,
  onToggle,
  onSetAll,
  onShow,
  onCreate,
  onDelete,
  onCancel,
  onToggleLoadMode,
  loadMode,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: SkillPanelProps) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)

  const filtered = filterSkillRows(rows, query)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0
  const current = filtered[safeIndex]
  const summary = skillSummary(rows)

  useInput(
    (input, key) => {
      if (key.escape) {
        if (query) {
          setQuery("")
          setIndex(0)
        } else onCancel()
        return
      }
      if (key.ctrl && (input === "n" || input === "N")) return onCreate()
      if (key.ctrl && (input === "x" || input === "X")) {
        if (current) onDelete(current.id)
        return
      }
      // Bulk "全开全关": Ctrl+A enables, Ctrl+D disables every row the current
      // filter shows (so you can filter "claude" then flip just those). With no
      // filter, that is every skill.
      if (key.ctrl && (input === "a" || input === "A")) {
        if (filtered.length > 0)
          onSetAll(
            filtered.map((r) => r.id),
            true
          )
        return
      }
      if (key.ctrl && (input === "d" || input === "D")) {
        if (filtered.length > 0)
          onSetAll(
            filtered.map((r) => r.id),
            false
          )
        return
      }
      // Ctrl+T flips the system-prompt cost mode: full bodies ⇄ name-only catalog.
      if (key.ctrl && (input === "t" || input === "T")) return onToggleLoadMode?.()
      if (key.upArrow) {
        setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1))
        return
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(filtered.length - 1, i + 1))
        return
      }
      if (input === " ") {
        if (current) onToggle(current.id)
        return
      }
      if (key.return) {
        if (current) onShow(current.id)
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
      <Text bold>
        Skills · {summary.total}
        <Text color={theme.muted}>
          {"  "}
          {summary.enabled} on
          {summary.issues > 0 ? ` · ${summary.issues} with issues` : ""}
          {loadMode ? ` · load: ${loadMode === "name" ? "name-only" : "full"}` : ""}
        </Text>
      </Text>
      <Text>
        <Text color={theme.muted}>filter: </Text>
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
          {visible.map((r, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            const badge = skillBadge(r)
            const hint = skillRowHint(r)
            return (
              <Text key={r.id} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                <Text color={theme[badge.token]}>{badge.glyph}</Text>
                {badge.warn ? <Text color={theme.warning}> ⚠</Text> : null} {r.name}
                {hint ? <Text color={theme.muted}> · {hint}</Text> : null}
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={SKILL_PANEL_FOOTER} />
    </Box>
  )
}
