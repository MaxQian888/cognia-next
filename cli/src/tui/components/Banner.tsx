/**
 * The welcome banner — the "top bar". A one-time header pinned to the top of the
 * scrollback (rendered as the first `<Static>` row by {@link Transcript}, and
 * shown on its own during the `"startup"` phase). Mirrors Claude Code's launch
 * banner: a logo line, the active provider/model, the working directory, and a
 * one-line hint. Pure presenter — every value is a prop.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { shortenCwd, formatTokens } from "../format/usage"
import type { BannerDensity } from "../layout/terminal-layout"

/**
 * Live status carried by the banner when it serves as the FIXED fullscreen
 * header (the scrollback banner omits it — it scrolls away, so the live footer
 * owns status there). Every field is optional; absent ones drop from the line.
 */
export interface BannerStatus {
  /** Permission mode, shown with a `⚠` when it's `bypassPermissions`. */
  mode?: string
  /** Latest-turn context-window occupancy (0–100), rendered as `NN% ctx`. */
  contextPct?: number
  /** Cumulative session output+input tokens, rendered as e.g. `12.3k tok`. */
  sessionTokens?: number
}

export function Banner({
  version,
  provider,
  model,
  cwd,
  status,
  density = "full",
}: {
  version: string
  provider: string
  model?: string
  cwd: string
  /** When present, renders a live status line — used by the fixed fullscreen
   * header so the banner carries mode / context / tokens without scrolling. */
  status?: BannerStatus
  density?: BannerDensity
}) {
  const theme = useTheme()
  const bypass = status?.mode === "bypassPermissions"
  const statusSegments: string[] = []
  if (status?.mode) statusSegments.push(bypass ? `⚠ ${status.mode}` : status.mode)
  if (typeof status?.contextPct === "number") {
    statusSegments.push(`${Math.round(status.contextPct)}% ctx`)
  }
  if (typeof status?.sessionTokens === "number") {
    statusSegments.push(`${formatTokens(status.sessionTokens)} tok`)
  }
  if (density === "compact") {
    return (
      <Box flexShrink={0}>
        <Text color={theme.accent} bold>
          ✻ Cognia
        </Text>
        <Text color={theme.muted}>
          {` · ${provider}${model ? `/${model}` : ""}${statusSegments.length ? ` · ${statusSegments.join(" · ")}` : ""}`}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      flexShrink={0}
    >
      <Text>
        <Text color={theme.accent} bold>
          {"✻ Cognia Agent"}
        </Text>
        <Text color={theme.muted}>{` v${version}`}</Text>
      </Text>
      <Text color={theme.muted}>
        {provider}
        {model ? ` · ${model}` : ""}
      </Text>
      <Text color={theme.muted}>{shortenCwd(cwd, density === "medium" ? 40 : 80)}</Text>
      {status && statusSegments.length > 0 && (
        <Text color={bypass ? theme.warning : theme.muted}>{statusSegments.join("  ·  ")}</Text>
      )}
      {density === "full" ? (
        <Text color={theme.muted} dimColor>
          {"/settings to configure · /inspect to expand output · /help · @ files · ! shell"}
        </Text>
      ) : null}
    </Box>
  )
}
