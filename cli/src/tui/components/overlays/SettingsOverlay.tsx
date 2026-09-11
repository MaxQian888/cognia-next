/**
 * The unified `/settings` panel: a sectioned hub over every tunable knob.
 *
 * The parent (App) owns `section` + row `index` in the
 * reducer overlay and reacts to the callbacks, mirroring {@link SelectList}. The
 * panel renders the {@link SettingsSectionView} model from
 * `runtime/settings-sections.ts`; it does no persistence itself. Enum
 * rows enter a local draft with Enter (←/→ cycle, Enter save, Esc cancel);
 * booleans toggle with Space via `onToggle`; delegate
 * and form rows hand off to an existing overlay via `onActivate`. `r` resets the
 * focused enum/boolean row to its product default via `onReset`. A help strip
 * below the rows shows the focused row's one-line description.
 */
import React, { useState } from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { useCliTranslations } from "../../i18n"
import { useScreenReader } from "../../render/context"
import { useTheme } from "../../theme/context"
import { windowList, windowListWithinRows } from "../list-window"
import { fitToWidth, stringWidth } from "../../markdown/width"
import {
  cycleEnum,
  type SettingsRow,
  type SettingsSectionView,
} from "../../runtime/settings-sections"

/** Right-hand display of a row's current value, styled by control type. */
function rowValue(
  row: SettingsRow,
  accent: string,
  muted: string,
  screenReader: boolean,
  editing = false
): React.ReactNode {
  const c = row.control
  if (c.type === "boolean") {
    return (
      <Text color={c.current ? accent : muted}>
        {screenReader ? row.value : c.current ? "[x]" : "[ ]"}
      </Text>
    )
  }
  if (c.type === "enum") {
    return (
      <Text color={accent} wrap="truncate-end">
        {editing ? `‹ ${row.value} ›` : row.value}
      </Text>
    )
  }
  if (c.type === "readonly") {
    return (
      <Text color={muted} wrap="truncate-end">
        {row.value}
      </Text>
    )
  }
  // delegate / form
  return <Text color={muted} wrap="truncate-end">{`${row.value} ›`}</Text>
}

export function SettingsOverlay({
  sections,
  section,
  index,
  width,
  maxRows,
  viewportRows,
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
  /** Entire measured overlay region, including chrome. */
  viewportRows?: number
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
  const t = useCliTranslations("cliUiSettings")
  const screenReader = useScreenReader()
  const active = sections[section]
  const rows = active?.rows ?? []
  const current = rows[index]
  const [draft, setDraft] = useState<{ section: number; rowId: string; delta: number } | null>(null)
  const editing =
    draft?.section === section && draft.rowId === current?.id && current?.control.type === "enum"
  const delta = editing ? draft.delta : 0
  const draftValue =
    editing && current.control.type === "enum"
      ? cycleEnum(current.control.options, current.control.current, delta)
      : undefined

  useModalInput(
    (input, key) => {
      if (key.escape) {
        if (editing) {
          setDraft(null)
          return
        }
        onClose()
        return
      }
      if (key.tab || input === "[" || input === "]") {
        setDraft(null)
        onSwitchSection(input === "[" || key.shift ? -1 : 1)
        return
      }
      if (key.upArrow) {
        setDraft(null)
        onMoveRow(-1)
        return
      }
      if (key.downArrow) {
        setDraft(null)
        onMoveRow(1)
        return
      }
      if (key.leftArrow || key.rightArrow) {
        const delta = key.rightArrow ? 1 : -1
        if (editing)
          setDraft((previous) =>
            previous ? { ...previous, delta: previous.delta + delta } : previous
          )
        else {
          setDraft(null)
          onSwitchSection(delta)
        }
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
        if (t === "enum" || t === "boolean") {
          setDraft(null)
          onReset(current)
        }
        return
      }
      if (key.return && current) {
        const c = current.control
        if (c.type === "enum" && !current.unavailable && c.options.length > 0) {
          if (editing) {
            setDraft(null)
            if (delta !== 0) onAdjust(current, delta)
          } else setDraft({ section, rowId: current.id, delta: 0 })
        } else if (c.type === "boolean") onToggle(current)
        else if (c.type === "delegate" || c.type === "form" || c.type === "credential")
          onActivate(current)
      }
    },
    { isActive }
  )

  const border = !screenReader && (viewportRows === undefined || viewportRows >= 8)
  const showTitle = viewportRows === undefined || viewportRows >= 5
  const showDescription =
    Boolean(current?.description || current?.unavailable) &&
    (viewportRows === undefined || viewportRows >= 8)
  const innerWidth = Math.max(1, (typeof width === "number" ? width : 80) - (border ? 4 : 2))
  const budget = Math.max(
    1,
    (viewportRows ?? Infinity) - (border ? 2 : 0) - Number(showTitle) - 2 - Number(showDescription)
  )
  const win =
    viewportRows === undefined
      ? windowList(rows.length, index, maxRows ?? rows.length)
      : windowListWithinRows(rows.length, index, Math.min(budget, maxRows ?? Infinity))
  const showIndicators = viewportRows === undefined || budget >= 3
  // Keep the active tab visible in a single terminal row.
  let tabStart = 0
  let tabEnd = sections.length
  const tabText = (i: number) => (i === section ? `[${sections[i].title}]` : sections[i].title)
  const tabSize = () =>
    sections
      .slice(tabStart, tabEnd)
      .reduce((sum, _, i) => sum + stringWidth(tabText(tabStart + i)) + 1, -1) +
    (tabStart > 0 ? 2 : 0) +
    (tabEnd < sections.length ? 2 : 0)
  while (tabEnd - tabStart > 1 && tabSize() > innerWidth) {
    if (section - tabStart > tabEnd - section - 1) tabStart++
    else tabEnd--
  }
  const visible = rows.slice(win.start, win.end)
  // Lay labels into a common column so the value column aligns. The cap has to
  // cut, not just pad: shipped labels run past 34 columns ("Desktop
  // notifications on completion (needs bell on)"), and a label emitted at full
  // length pushes its own value right and breaks the column for every row.
  const labelWidth = Math.min(
    34,
    Math.max(1, Math.floor(innerWidth / 2) - 4),
    Math.max(0, ...rows.map((r) => stringWidth(r.label)))
  )

  return (
    <Box
      flexDirection="column"
      borderStyle={border ? "round" : undefined}
      borderColor={theme.border}
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      {/* Title + focused-row position (row N of M in the active section). */}
      {showTitle ? (
        <Box justifyContent="space-between">
          <Text bold>{t("title")}</Text>
          {rows.length > 0 ? (
            <Text color={theme.muted}>{`${index + 1}/${rows.length}`}</Text>
          ) : null}
        </Box>
      ) : null}
      {/* Section tabs */}
      <Text wrap="truncate-end">
        {tabStart > 0 ? "‹ " : ""}
        {sections.slice(tabStart, tabEnd).map((s, i) => (
          <Text
            key={s.id}
            color={tabStart + i === section ? theme.accent : theme.muted}
            bold={tabStart + i === section}
          >
            {i > 0 ? " " : ""}
            {tabText(tabStart + i)}
          </Text>
        ))}
        {tabEnd < sections.length ? " ›" : ""}
      </Text>
      {showIndicators && win.above > 0 ? (
        <Text color={theme.muted} dimColor>
          {t("moreAbove", { count: win.above })}
        </Text>
      ) : null}
      {visible.map((row, i) => {
        const at = win.start + i
        const focused = at === index
        return (
          <Box key={row.id} flexShrink={0}>
            <Text color={focused ? theme.accent : undefined} bold={focused}>
              {focused ? "❯ " : "  "}
              {fitToWidth(row.label, labelWidth)}
              {"  "}
            </Text>
            {/* A row the active backend cannot honour shows "unavailable"
                instead of a value it would never apply. */}
            <Box flexGrow={1} minWidth={0}>
              {row.unavailable ? (
                <Text color={theme.muted} dimColor>
                  {t("unavailable")}
                </Text>
              ) : (
                rowValue(
                  focused && editing ? { ...row, value: draftValue ?? row.value } : row,
                  theme.accent,
                  theme.muted,
                  screenReader,
                  focused && editing
                )
              )}
            </Box>
          </Box>
        )
      })}
      {showIndicators && win.below > 0 ? (
        <Text color={theme.muted} dimColor>
          {t("moreBelow", { count: win.below })}
        </Text>
      ) : null}
      {/* Help strip: WHY the focused row is unavailable takes precedence over
          its description — that is the thing the user needs right then. */}
      {showDescription && current?.unavailable ? (
        <Text color={theme.muted} wrap="truncate-end">{`  ${current.unavailable}`}</Text>
      ) : showDescription && current?.description ? (
        <Text color={theme.muted} wrap="truncate-end">{`  ${current.description}`}</Text>
      ) : null}
      <Text color={editing ? theme.accent : theme.muted} wrap="truncate-end">
        {t(
          editing
            ? innerWidth < 36
              ? "editFooterTiny"
              : innerWidth < 70
                ? "editFooterCompact"
                : "editFooter"
            : innerWidth < 36
              ? "footerTiny"
              : innerWidth < 70
                ? "footerCompact"
                : "footer"
        )}
      </Text>
    </Box>
  )
}
