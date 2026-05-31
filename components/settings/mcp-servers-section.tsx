"use client"

/**
 * MCP servers settings entry — hosts the full multi-tab {@link McpPanel}
 * (My Servers / Preset Market / Agent Sync / Health & Logs).
 *
 * The legacy single-file section was refactored into `components/settings/mcp/`
 * for parity with the Skills panel (motion, responsive layout, view/grouping,
 * batch ops). This wrapper stretches the panel to a fixed viewport height so
 * its internal scroll + tabs stay usable inside the Settings shell's outer
 * ScrollArea — mirroring `components/settings/sections/skills-section.tsx`.
 */

import { McpPanel } from "@/components/settings/mcp/mcp-panel"
import { cn } from "@/lib/utils"

interface Props {
  className?: string
}

export function McpServersSection({ className }: Props) {
  return (
    <div
      className={cn(
        "h-[calc(100dvh-var(--settings-header-h,8rem))] -mx-3 -my-3 overflow-hidden sm:-mx-4 sm:-my-4 md:-mx-5 md:-my-5 lg:-mx-6 lg:-my-6",
        className
      )}
      data-testid="mcp-servers-section"
    >
      <McpPanel />
    </div>
  )
}

export default McpServersSection
