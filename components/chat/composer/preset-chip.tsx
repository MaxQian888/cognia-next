"use client"

/**
 * The system-prompt preset picker, on the composer's status line.
 *
 * It was built for the chat header (ADR-0127) and mounted there beside the
 * title. With the header projected into the shell's title bar that row is
 * chrome — window, navigation, launchers — and "which preset shapes this
 * session" is not chrome: it answers the same kind of question the model and
 * permission chips answer, so it lives with them under the input box.
 *
 * Owns the whole apply path the header used to: a conflict-free pick applies
 * in place (fill-empty) and records usage; a pick that would overwrite values
 * the session already holds opens the session settings sheet, which owns the
 * conflict-resolution dialog. Self-hides without presets.
 */

import { useMemo, useState } from "react"
import { ChatHeaderPresetPill } from "@/components/chat/chat-header-preset-pill"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { usePresets, useRecordPresetUsage, useUpdateSession } from "@/lib/data-hooks/context"
import { buildPresetApplicationPlan, detectPresetConflicts } from "@/lib/presets/apply-to-session"
import { loggers } from "@cognia/logging"
import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession
  disabled?: boolean
  /** Styling for the pill's trigger — the toolbar hands over its quiet chip. */
  className?: string
}

export function ComposerPresetChip({ session, disabled, className }: Props) {
  const presetsRaw = usePresets()
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const updateSession = useUpdateSession()
  const recordPresetUsage = useRecordPresetUsage()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleSelectPreset = (preset: SystemPromptPreset) => {
    const conflicts = detectPresetConflicts(preset, session)
    if (conflicts.length > 0) {
      setSettingsOpen(true)
      return
    }
    const plan = buildPresetApplicationPlan(preset, session, "fill-empty")
    void updateSession(session.id, { ...plan.sessionPatch, activePresetId: preset.id }).catch(
      (err: unknown) => {
        loggers.chat.error("preset chip apply failed", err, {
          sessionId: session.id,
          presetId: preset.id,
        })
      }
    )
    void recordPresetUsage(preset.id).catch((err: unknown) => {
      loggers.chat.warn("recordPresetUsage failed", {
        presetId: preset.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  if (presets.length === 0) return null

  return (
    <>
      <ChatHeaderPresetPill
        session={session}
        presets={presets}
        onSelectPreset={handleSelectPreset}
        disabled={disabled}
        triggerClassName={className}
        align="start"
      />
      <SessionSettingsSheet session={session} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}
