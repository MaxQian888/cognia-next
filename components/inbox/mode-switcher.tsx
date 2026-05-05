"use client"

/**
 * Mode switcher chip for the Inbox conversation header.
 *
 * Renders a clickable badge that opens a dropdown with "auto / manual / draft"
 * options. On change:
 *  1. Writes the new mode to conversationOverrides via upsertByConversationKey.
 *  2. Cancels any in-flight AI run for the conversation by invoking the Tauri
 *     `claude_interrupt` command. This is necessary so a running auto-mode
 *     stream does not keep writing after the user switches to manual/draft.
 *     The invoke is best-effort; errors are swallowed (the interrupt is a
 *     safety valve, not a hard gate).
 */

import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { isTauri } from "@/lib/tauri"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import type { ConnectorMode } from "@/types/connectors/policy"
import { ALL_MODES } from "@/types/connectors/policy"

interface ModeSwitcherProps {
  conversationKey: string
  sessionId: string
  currentMode: ConnectorMode
  onModeChange?: (mode: ConnectorMode) => void
}

const MODE_LABELS: Record<ConnectorMode, string> = {
  auto: "Auto",
  manual: "Manual",
  draft: "Draft",
}

export function ModeSwitcher({
  conversationKey,
  sessionId,
  currentMode,
  onModeChange,
}: ModeSwitcherProps) {
  const [pending, setPending] = useState(false)

  const handleSelect = async (mode: ConnectorMode) => {
    if (mode === currentMode || pending) return
    setPending(true)
    try {
      // 1. Persist the override.
      await upsertByConversationKey({
        conversationKey,
        sessionId,
        mode,
      })

      // 2. Cancel any in-flight AI run for this conversation.
      //    We call claude_interrupt which kills the active streaming run for
      //    the bound ChatSession. Best-effort: the conversation is still
      //    accessible even if the interrupt fails.
      if (isTauri()) {
        try {
          await invoke("claude_interrupt", { session_id: sessionId })
        } catch {
          // Swallow — interrupt is best-effort; the override write already succeeded.
        }
      }

      onModeChange?.(mode)
    } finally {
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          data-testid="mode-switcher-trigger"
          aria-label="Switch mode"
        >
          <Badge variant="secondary" className="cursor-pointer select-none">
            {MODE_LABELS[currentMode]}
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ALL_MODES.map((mode) => (
          <DropdownMenuItem
            key={mode}
            onClick={() => void handleSelect(mode)}
            data-testid={`mode-option-${mode}`}
          >
            {MODE_LABELS[mode]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
