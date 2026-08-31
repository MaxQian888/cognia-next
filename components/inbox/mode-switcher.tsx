"use client"

/**
 * Behaviour-mode chip for the Inbox conversation header.
 *
 * ## One vocabulary, not three
 *
 * This chip used to speak the legacy `ConnectorMode` (`auto`/`manual`/`draft`)
 * while the settings behaviour editor spoke the four named presets over the
 * composition axes (ADR-0117). Worse, it CLEARED `autonomy` and `engagement`
 * on every pick, so a conversation the operator had set to `delegate` in
 * settings silently became `assistant` the first time anyone touched the chip.
 * The presets are the vocabulary now, and `mode` is written only as the
 * compatibility mirror `imModePresetPatch` produces.
 *
 * `custom` is a read-out, never a choice. When the stored axes add up to a
 * combination no preset names (a `confirm` or `autopilot` autonomy, say),
 * picking it opens the override dialog the header already mounts rather than
 * inventing a second axis editor here.
 *
 * ## What a pick writes
 *
 *  1. The preset's axes plus the legacy mirror, through
 *     `mutateConversationOverride` (ADR-0131: the same Dexie upsert on a
 *     connector host, a local mirror plus a relayed authoritative write on a
 *     thin client).
 *  2. `ASSIGNMENT_ROUTING_MARKER_CLEAR`, because an explicit operator edit is
 *     exactly the event that makes "an SLA step chose this" stop being true.
 *     Every other explicit-edit path (`/mode`, the override form) already
 *     cleared it. This one did not, so an operator's own pick kept rendering
 *     as escalation-forced and a later unassign could undo it.
 *  3. A best-effort `claude_interrupt`, so a running auto-mode stream does not
 *     keep writing after the operator switches to draft or silent. Desktop
 *     only, because it is a Tauri command, unlike the override write above.
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
import { ASSIGNMENT_ROUTING_MARKER_CLEAR } from "@/lib/db/conversation-overrides"
import {
  IM_MODE_CUSTOM,
  IM_MODE_PRESET_IDS,
  imModePresetPatch,
  imModePresetUnavailableReason,
  type ImModePresetId,
  type ImModeSelection,
} from "@/lib/connectors/composition/im-mode-presets"
import type { ImTargetKind } from "@/lib/connectors/composition/mode-projection"

interface ModeSwitcherProps {
  conversationKey: string
  sessionId: string
  /** The preset the conversation's stored axes currently add up to. */
  selection: ImModeSelection
  /**
   * The conversation's effective execution target. Only `delegate` depends on
   * it: background work needs a team or workflow to carry it, so offering the
   * preset without one would offer a value nothing acts on.
   */
  targetKind: ImTargetKind
  /** Open the per-conversation settings dialog (the `custom` destination). */
  onOpenAdvanced?: () => void
  onSelectionChange?: (selection: ImModePresetId) => void
}

export function ModeSwitcher({
  conversationKey,
  sessionId,
  selection,
  targetKind,
  onOpenAdvanced,
  onSelectionChange,
}: ModeSwitcherProps) {
  const t = useTranslations("inbox.modeSwitcher")
  const [pending, setPending] = useState(false)

  const handleSelect = async (preset: ImModePresetId) => {
    if (preset === selection || pending) return
    if (imModePresetUnavailableReason(preset, targetKind) !== null) return
    setPending(true)
    try {
      await mutateConversationOverride({
        kind: "upsert",
        input: {
          conversationKey,
          sessionId,
          ...imModePresetPatch(preset),
          ...ASSIGNMENT_ROUTING_MARKER_CLEAR,
        },
      })

      if (isTauri()) {
        try {
          await invoke("claude_interrupt", { session_id: sessionId })
        } catch {
          // Swallow. The interrupt is best-effort, and the override write has
          // already succeeded.
        }
      }

      onSelectionChange?.(preset)
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
          data-selection={selection}
          aria-label={t("aria")}
          className="h-6 px-2 text-xs"
        >
          {t(`presets.${selection}`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {IM_MODE_PRESET_IDS.map((preset) => {
            const reason = imModePresetUnavailableReason(preset, targetKind)
            return (
              <DropdownMenuItem
                key={preset}
                disabled={reason !== null}
                onClick={() => void handleSelect(preset)}
                data-testid={`mode-option-${preset}`}
              >
                <span className="flex flex-col gap-0.5">
                  <span>{t(`presets.${preset}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {reason ? t(`unavailable.${reason}`) : t(`presetHelp.${preset}`)}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
          {/* Offered only when the stored axes already ARE custom, so the menu
              never advertises a state the operator cannot reach from here. */}
          {selection === IM_MODE_CUSTOM && (
            <DropdownMenuItem
              onClick={() => onOpenAdvanced?.()}
              data-testid={`mode-option-${IM_MODE_CUSTOM}`}
            >
              <span className="flex flex-col gap-0.5">
                <span>{t(`presets.${IM_MODE_CUSTOM}`)}</span>
                <span className="text-xs text-muted-foreground">{t("customHelp")}</span>
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
