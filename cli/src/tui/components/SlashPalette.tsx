/**
 * Presentational `/` command palette shown below the composer. Stateless — the
 * `Input` component owns the keyboard and the highlighted index.
 */
import React from "react"
import { Box, Text } from "ink"

import type { SlashCommand } from "../commands/registry"
import { useTheme } from "../theme/context"
import { windowList } from "./list-window"
import { formatArgHint } from "../commands/arg-hint"
import { useCliTranslations } from "../i18n"

const MAX_ROWS = 8

export function SlashPalette({
  matches,
  index,
  query = "",
  maxRows = MAX_ROWS,
  width,
}: {
  matches: SlashCommand[]
  index: number
  /** Text after the leading slash; rendered as an explicit search affordance. */
  query?: string
  /** Cap the visible rows; the list scrolls to keep the highlight on-screen. */
  maxRows?: number
  /** Box width (terminal columns) so the palette spans the full width. */
  width?: number | string
}) {
  const theme = useTheme()
  const t = useCliTranslations("cliUiCommands")
  if (matches.length === 0) return null
  const win = windowList(matches.length, index, maxRows)
  const visible = matches.slice(win.start, win.end)
  const separator = query.search(/\s/)
  const parent = separator < 0 ? "" : query.slice(0, separator)
  const search = parent ? query.slice(separator).trimStart() : query
  const selected = matches[index]
  const action = parent ? "choose" : selected?.subcommands?.length ? "open" : "run"
  const compact = typeof width === "number" && width < 70
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderSubtle}
      paddingX={1}
      width={width}
    >
      <Text color={theme.muted} wrap="truncate-end">
        {parent ? <Text color={theme.accent}>/{parent} › </Text> : t("palette.search")}
        <Text color={theme.accent}>{search || t(parent ? "palette.actions" : "palette.all")}</Text>
        {"  ·  "}
        {t(`palette.${compact ? "compact" : "keys"}`, { action: t(`palette.${action}`) })}
      </Text>
      {win.above > 0 ? (
        <Text color={theme.muted} dimColor>{`  ↑ ${t("palette.more", { count: win.above })}`}</Text>
      ) : null}
      {visible.map((cmd, i) => {
        const row = win.start + i
        const children = cmd.subcommands?.length ?? 0
        const hint = children ? t("palette.childCount", { count: children }) : formatArgHint(cmd)
        const name = parent ? cmd.name.slice(cmd.name.indexOf(" ") + 1) : `/${cmd.name}`
        return (
          <Text
            key={cmd.name}
            color={row === index ? theme.accent : undefined}
            bold={row === index}
            wrap="truncate-end"
          >
            {row === index ? "❯ " : "  "}
            {name}
            {hint ? (
              <Text color={theme.secondary}>
                {" "}
                {hint}
                {children ? " ›" : ""}
              </Text>
            ) : null}
            <Text color={theme.muted}> — {cmd.description}</Text>
          </Text>
        )
      })}
      {win.below > 0 ? (
        <Text color={theme.muted} dimColor>{`  ↓ ${t("palette.more", { count: win.below })}`}</Text>
      ) : null}
    </Box>
  )
}
