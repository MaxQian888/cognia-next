"use client"

/**
 * MCP servers settings entry — hosts the full multi-tab {@link McpPanel}
 * (My Servers / Preset Market / Agent Sync / Health & Logs).
 *
 * `mcp` is a member of the settings shell's `FILL_HEIGHT_SECTIONS`, so it
 * renders in the fixed-frame branch: a full-width, `flex-1`/`min-h-0` column
 * that already supplies bounded height and uniform padding. This wrapper just
 * fills that frame and lets the panel's own master-detail layout manage the
 * internal scroll.
 *
 * The previous version guessed `100dvh - var(--settings-header-h, 8rem)` — a
 * variable nothing defines — and cancelled the shell's padding with negative
 * margins, inside the capped `max-w-5xl` ScrollArea branch. That produced the
 * three visible symptoms this replaces: wasted width on a wide window, a
 * second scrollbar, and a frame taller or shorter than the actual pane.
 * Mirrors `components/settings/sections/skills-section.tsx`.
 */

import { McpPanel } from "@/components/settings/mcp/mcp-panel"
import { cn } from "@/lib/utils"

interface Props {
  className?: string
}

export function McpServersSection({ className }: Props) {
  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden", className)}
      data-testid="mcp-servers-section"
    >
      <McpPanel />
    </div>
  )
}

export default McpServersSection
