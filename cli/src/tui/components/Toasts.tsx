/**
 * Transient toast stack, rendered just above the composer (see BottomRegion).
 * Distinct from the permanent scrollback notice/error cells: these are ephemeral
 * alerts for events that would otherwise pass silently — sidecar death, rate
 * limits, MCP load failures, background-run errors — and auto-expire via
 * {@link useToastExpiry}. Severity drives the glyph + colour.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import type { Toast, ToastSeverity } from "../state/types"

const GLYPH: Record<ToastSeverity, string> = { info: "ℹ", warn: "⚠", error: "✗" }

export function Toasts({ toasts }: { toasts: Toast[] }): React.ReactElement | null {
  const theme = useTheme()
  if (toasts.length === 0) return null
  const colorFor = (s: ToastSeverity): string =>
    s === "error" ? theme.danger : s === "warn" ? theme.warning : theme.info
  return (
    <Box flexDirection="column" flexShrink={0}>
      {toasts.map((t) => (
        <Box key={t.id} flexDirection="column">
          <Text color={colorFor(t.severity)}>
            {GLYPH[t.severity]} {t.message}
          </Text>
          {t.hint && (
            <Text color={theme.muted} dimColor>
              {"  ↳ "}
              {t.hint}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
