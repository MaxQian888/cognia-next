/**
 * The one frame every pre-chat phase draws in.
 *
 * Startup, connect, install and failure each returned their own layout tree, so
 * moving between them replaced the whole frame: in fullscreen the height
 * collapsed and re-expanded (a full-screen repaint per phase), and nothing
 * bounded the body, so a long install log or a wrapped failure message could
 * push the recovery list and the cancellation hint off the bottom.
 *
 * One shell fixes all of it. The banner sits in a fixed, non-shrinking top
 * region; the body gets a bounded region that scrolls/truncates inside itself;
 * the hint sits in a fixed bottom region that content can never displace. When
 * the terminal is too short for all three, {@link launchShellLayout} drops the
 * banner first — it is decoration, and the thing the user must act on is not.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { launchShellLayout } from "./launch-shell-layout"

export function LaunchShell({
  banner,
  hint,
  columns,
  rows,
  fullscreen,
  children,
}: {
  /** The welcome banner. Dropped automatically on a short terminal. */
  banner?: React.ReactNode
  /** Persistent bottom line (e.g. "Esc to cancel"). Never pushed off screen. */
  hint?: string
  columns: number
  rows: number
  /** Pin the frame to the full terminal height, as the chat layout does. */
  fullscreen: boolean
  children: React.ReactNode
}) {
  const theme = useTheme()
  const layout = launchShellLayout(rows, Boolean(hint))
  return (
    <Box
      flexDirection="column"
      width={columns}
      // The SAME height rule as the chat layout, so entering the chat does not
      // resize the frame and force a repaint.
      {...(fullscreen ? { height: rows } : {})}
    >
      {layout.showBanner && banner ? <Box flexShrink={0}>{banner}</Box> : null}
      {/* The body owns the remaining rows and is bounded, so its own content
          cannot grow the frame past the terminal. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        {...(fullscreen ? { height: layout.bodyRows } : {})}
      >
        {children}
      </Box>
      {layout.showHint && hint ? (
        <Box flexShrink={0}>
          <Text color={theme.muted} dimColor>
            {hint}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
