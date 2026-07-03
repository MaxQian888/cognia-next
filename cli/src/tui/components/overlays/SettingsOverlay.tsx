/**
 * The unified `/settings` panel: a sectioned hub over every tunable knob.
 *
 * Stateless / controlled — the parent (App) owns `section` + row `index` in the
 * reducer overlay and reacts to the callbacks, mirroring {@link SelectList}. The
 * panel renders the {@link SettingsSectionView} model from
 * `runtime/settings-sections.ts`; it does no persistence itself. Enum/boolean
 * rows edit inline (←/→ cycle, Space toggle) via `onAdjust`/`onToggle`; delegate
 * and form rows hand off to an existing overlay via `onActivate`. `r` resets the
 * focused enum/boolean row to its product default via `onReset`. A help strip
 * below the rows shows the focused row's one-line description.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../../theme/context"
import { windowList } from "../list-window"
import { OverlayFooter } from "../OverlayFooter"
import type { SettingsRow, SettingsSectionView } from "../../runtime/settings-sections"

const FOOTER_HINT =
  "Tab section · ↑/↓ row · ←/→ change · Space toggle · Enter open · r reset · Esc close"

/** Right-hand display of a row's current value, styled by control type. */
function rowValue(row: SettingsRow, accent: string, muted: string): React.ReactNode {
  const c = row.control
  if (c.type === "boolean") {
    return <Text color={c.current ? accent : muted}>{c.current ? "[x]" : "[ ]"}</Text>
  }
  if (c.type === "enum") {
    return <Text color={accent}>{`‹ ${row.value} ›`}</Text>
  }
  if (c.type === "readonly") {
    return <Text color={muted}>{row.value}</Text>
  }
  // delegate / form
  return <Text color={muted}>{`${row.value} ›`}</Text>
}

export function SettingsOverlay({
  sections,
  section,
  index,
  width,
  maxRows,
  onMoveRow,
  onSwitchSection,
  onAdjust,
  onToggle,
  onActivate,
  onReset,
  onClose,
  isActive = true,
}: {
  sections: SettingsSectionView[]
  section: number
  index: number
  width?: number | string
  maxRows?: number
  onMoveRow: (delta: number) => void
  onSwitchSection: (delta: number) => void
  onAdjust: (row: SettingsRow, delta: number) => void
  onToggle: (row: SettingsRow) => void
  onActivate: (row: SettingsRow) => void
  /** Reset the focused enum/boolean row to its product default. */
  onReset?: (row: SettingsRow) => void
  onClose: () => void
  isActive?: boolean
}) {
  const theme = useTheme()
  const active = sections[section]
  const rows = active?.rows ?? []
  const current = rows[index]

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose()
        return
      }
      if (key.tab) {
        onSwitchSection(key.shift ? -1 : 1)
        return
      }
      if (key.upArrow) {
        onMoveRow(-1)
        return
      }
      if (key.downArrow) {
        onMoveRow(1)
        return
      }
      if (key.leftArrow || key.rightArrow) {
        const delta = key.rightArrow ? 1 : -1
        // ←/→ cycles an enum row's value; on any other row it switches section.
        if (current?.control.type === "enum") onAdjust(current, delta)
        else onSwitchSection(delta)
        return
      }
      if (input === " ") {
        if (current?.control.type === "boolean") onToggle(current)
        return
      }
      // `r` resets the focused row to its product default (enum/boolean only;
      // delegate/form/readonly rows have no default to reset to).
      if ((input === "r" || input === "R") && current && onReset) {
        const t = current.control.type
        if (t === "enum" || t === "boolean") onReset(current)
        return
      }
      if (key.return && current) {
        const c = current.control
        if (c.type === "enum") onAdjust(current, 1)
        else if (c.type === "boolean") onToggle(current)
        else if (c.type === "delegate" || c.type === "form") onActivate(current)
      }
    },
    { isActive }
  )

  const win = windowList(rows.length, index, maxRows ?? rows.length)
  const visible = rows.slice(win.start, win.end)
  // Pad labels to a common width so the value column aligns.
  const labelWidth = Math.min(34, Math.max(0, ...rows.map((r) => r.label.length)))

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      {/* Title + focused-row position (row N of M in the active section). */}
      <Box justifyContent="space-between">
        <Text bold>Settings</Text>
        {rows.length > 0 ? <Text color={theme.muted}>{`${index + 1}/${rows.length}`}</Text> : null}
      </Box>
      {/* Section tabs */}
      <Box>
        {sections.map((s, i) => (
          <Text key={s.id} color={i === section ? theme.accent : theme.muted} bold={i === section}>
            {i === section ? `[${s.title}]` : ` ${s.title} `}
            {i < sections.length - 1 ? " " : ""}
          </Text>
        ))}
      </Box>
      {win.above > 0 ? <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((row, i) => {
        const at = win.start + i
        const focused = at === index
        return (
          <Box key={row.id}>
            <Text color={focused ? theme.accent : undefined} bold={focused}>
              {focused ? "❯ " : "  "}
              {row.label.padEnd(labelWidth)}
              {"  "}
            </Text>
            {rowValue(row, theme.accent, theme.muted)}
          </Box>
        )
      })}
      {win.below > 0 ? <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text> : null}
      {/* Help strip: the focused row's one-line description. */}
      {current?.description ? (
        <Text color={theme.muted} wrap="truncate-end">{`  ${current.description}`}</Text>
      ) : null}
      <OverlayFooter hint={FOOTER_HINT} />
    </Box>
  )
}
