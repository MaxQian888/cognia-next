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
import { useTranslations } from "next-intl"
import { invoke } from "@tauri-apps/api/core"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import type { ConnectorMode } from "@/types/connectors/policy"
import { ALL_MODES } from "@/types/connectors/policy"

interface ModeSwitcherProps {
  conversationKey: string
  sessionId: string
  currentMode: ConnectorMode
  onModeChange?: (mode: ConnectorMode) => void
}

export function ModeSwitcher({
  conversationKey,
  sessionId,
  currentMode,
  onModeChange,
}: ModeSwitcherProps) {
  const t = useTranslations("inbox.modeSwitcher")
  const [pending, setPending] = useState(false)

  const handleSelect = async (mode: ConnectorMode) => {
    if (mode === currentMode || pending) return
    setPending(true)
    try {
      // 1. Persist the override. ADR-0131: on a connector host this is the
      //    same Dexie upsert; on a thin client it mirrors locally and relays
      //    the authoritative write to the paired host.
      await mutateConversationOverride({
        kind: "upsert",
        input: { conversationKey, sessionId, mode },
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
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          data-testid="mode-switcher-trigger"
          aria-label={t("aria")}
          className="h-6 px-2 text-xs"
        >
          {t(`modes.${currentMode}`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {ALL_MODES.map((mode) => (
            <DropdownMenuItem
              key={mode}
              onClick={() => void handleSelect(mode)}
              data-testid={`mode-option-${mode}`}
            >
              {t(`modes.${mode}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
