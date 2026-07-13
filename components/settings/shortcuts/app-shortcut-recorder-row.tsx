"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { parseKeyEvent, formatKeybinding } from "@/lib/shortcuts/utils"
import { findAppConflict } from "@/lib/shortcuts/unified"
import type { AppShortcutRow } from "@/lib/shortcuts/unified"
import { getReservedShortcutConflict, type ReservedConflict } from "@/lib/shortcuts/reserved"

interface AppShortcutRecorderRowProps {
  row: AppShortcutRow
  onRebind: (id: string, chord: string) => void
  onReset: (id: string) => void
  /** Human label for another shortcut id, for the conflict message. */
  labelForId: (id: string) => string
}

/**
 * One rebindable app-scope shortcut. While recording it captures keys in the
 * capture phase and stops propagation, so the single app dispatcher never fires
 * a shortcut mid-recording. Save is blocked while the recorded chord collides
 * with another (non-mutually-exclusive) app shortcut.
 */
export function AppShortcutRecorderRow({
  row,
  onRebind,
  onReset,
  labelForId,
}: AppShortcutRecorderRowProps) {
  const t = useTranslations("settings.shortcuts")
  const { descriptor, chord, isModified } = row
  const [recording, setRecording] = useState(false)
  const [recorded, setRecorded] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [reserved, setReserved] = useState<ReservedConflict | null>(null)
  const recordingRef = useRef(false)
  // eslint-disable-next-line react-hooks/refs -- mirror recording flag into a ref so the capture-phase listener reads the latest value without re-subscribing.
  recordingRef.current = recording

  useEffect(() => {
    if (!recording) return
    function onKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") return
      const next = parseKeyEvent(e)
      setRecorded(next)
      setConflict(findAppConflict(next, descriptor.id))
      setReserved(getReservedShortcutConflict(next))
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [recording, descriptor.id])

  function start() {
    setRecorded(null)
    setConflict(null)
    setReserved(null)
    setRecording(true)
  }

  function cancel() {
    setRecording(false)
    setRecorded(null)
    setConflict(null)
    setReserved(null)
  }

  function save() {
    if (!recorded || conflict) return
    onRebind(descriptor.id, recorded)
    cancel()
  }

  const displayChord = recording
    ? recorded
      ? formatKeybinding(recorded)
      : t("pressKey")
    : chord
      ? formatKeybinding(chord)
      : t("notSet")

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {t(`catalog.${labelSuffix(descriptor.labelKey)}`)}
        </div>
        <div className="font-mono text-xs text-muted-foreground">{displayChord}</div>
        {recording && conflict && (
          <div className="text-xs text-destructive">
            {t("conflictWith")} {labelForId(conflict)}
          </div>
        )}
        {recording && !conflict && reserved && (
          <div className="text-xs text-amber-600 dark:text-amber-500">
            {t("reservedWarning", { feature: reserved.feature })}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {recording ? (
          <>
            <Button size="sm" variant="secondary" onClick={cancel}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={save} disabled={!recorded || Boolean(conflict)}>
              {t("save")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={start}>
              {t("record")}
            </Button>
            {isModified && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onReset(descriptor.id)}
                aria-label={t("resetItem")}
              >
                <RotateCcwIcon className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** `settings.shortcuts.catalog.terminalToggle` → `terminalToggle`. */
function labelSuffix(labelKey: string): string {
  return labelKey.split(".").pop() ?? labelKey
}
