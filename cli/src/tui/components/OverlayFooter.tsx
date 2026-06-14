/**
 * A dim one-line key hint shown at the bottom of an overlay. Centralises the
 * `↑/↓ navigate · Enter select · Esc cancel` affordance so every select-style
 * overlay reads the same; overridable per overlay via the `hint` prop.
 */
import React from "react"
import { Text } from "ink"

import { useTheme } from "../theme/context"

export const DEFAULT_OVERLAY_HINT = "↑/↓ navigate · Enter select · Esc cancel"

export function OverlayFooter({ hint = DEFAULT_OVERLAY_HINT }: { hint?: string }) {
  const theme = useTheme()
  return (
    <Text color={theme.muted} dimColor>
      {hint}
    </Text>
  )
}
