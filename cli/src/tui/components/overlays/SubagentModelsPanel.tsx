/**
 * The `/agents models` panel: a controlled master list that assigns a
 * provider/model to each dispatchable subagent. Stateless like
 * {@link SettingsOverlay} — the parent (App) owns the cursor `index` in the
 * reducer overlay and reopens the panel with fresh rows after each edit, so the
 * displayed value always reflects the just-persisted `config.subagentModels`.
 *
 * Keyboard: ↑/↓ move · ←/→ cycle the focused row's model · `p` cycle its
 * provider · `r` reset it to inherit · Esc close. Each non-move key fires a
 * callback the App turns into a {@link setSubagentModel} write.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../../theme/context"
import { windowList } from "../list-window"
import { OverlayFooter } from "../OverlayFooter"
import { SUBAGENT_MODELS_FOOTER, type SubagentModelRow } from "../../runtime/subagent-models-model"

const DEFAULT_MAX_ROWS = 10

/** Theme token + short label for a row's resolution source. */
function sourceBadge(source: SubagentModelRow["source"]): {
  token: "accent" | "secondary" | "muted"
  label: string
} {
  switch (source) {
    case "override":
      return { token: "accent", label: "override" }
    case "frontmatter":
      return { token: "secondary", label: "frontmatter" }
    case "inherit":
      return { token: "muted", label: "inherit" }
  }
}

export interface SubagentModelsPanelProps {
  rows: SubagentModelRow[]
  index: number
  onMove: (delta: number) => void
  onCycleModel: (row: SubagentModelRow, delta: number) => void
  onCycleProvider: (row: SubagentModelRow, delta: number) => void
  onReset: (row: SubagentModelRow) => void
  onClose: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function SubagentModelsPanel({
  rows,
  index,
  onMove,
  onCycleModel,
  onCycleProvider,
  onReset,
  onClose,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: SubagentModelsPanelProps): React.ReactElement {
  const theme = useTheme()
  const safeIndex = rows.length > 0 ? Math.min(index, rows.length - 1) : 0
  const current = rows[safeIndex]

  useInput(
    (input, key) => {
      if (key.escape) return onClose()
      if (key.upArrow) return onMove(-1)
      if (key.downArrow) return onMove(1)
      if (!current) return
      if (key.leftArrow) return onCycleModel(current, -1)
      if (key.rightArrow) return onCycleModel(current, 1)
      if (input === "p" || input === "P") return onCycleProvider(current, input === "P" ? -1 : 1)
      if (input === "r" || input === "R") return onReset(current)
    },
    { isActive }
  )

  const overrides = rows.filter((r) => r.source === "override").length
  const win = windowList(rows.length, safeIndex, maxRows)
  const visible = rows.slice(win.start, win.end)
  const labelWidth = Math.min(24, Math.max(0, ...rows.map((r) => r.name.length)))

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>
        Subagent models{" "}
        <Text color={theme.muted}>
          · {rows.length} agent{rows.length === 1 ? "" : "s"} · {overrides} overridden
        </Text>
      </Text>
      {rows.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no subagents found — add markdown files under .cognia/agents/
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
          ) : null}
          {visible.map((row, i) => {
            const at = win.start + i
            const focused = at === safeIndex
            const badge = sourceBadge(row.source)
            const model = row.model ?? "default"
            return (
              <Box key={row.id} flexDirection="column">
                <Box>
                  <Text color={focused ? theme.accent : undefined} bold={focused}>
                    {focused ? "❯ " : "  "}
                    {row.name.padEnd(labelWidth)}
                    {"  "}
                  </Text>
                  <Text color={theme.muted}>{row.provider} / </Text>
                  <Text color={focused ? theme.accent : theme.secondary} bold={focused}>
                    {`‹ ${model} ›`}
                  </Text>
                  <Text color={theme[badge.token]}> {badge.label}</Text>
                </Box>
                {focused && row.description ? (
                  <Text color={theme.muted} dimColor>
                    {"    "}
                    {row.description.replace(/\s+/g, " ").slice(0, 72)}
                  </Text>
                ) : null}
              </Box>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={SUBAGENT_MODELS_FOOTER} />
    </Box>
  )
}
