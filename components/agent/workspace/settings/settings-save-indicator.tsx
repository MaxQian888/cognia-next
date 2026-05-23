"use client"

/**
 * Settings tab header strip: a persistent "saved Ns ago" indicator plus an
 * "Audit now" button that re-runs the agent-team capability audit.
 *
 * Eager-save sections (Overview rows, Plugins, Governance, Memory) call the
 * module-level `markSettingsSaved()` after each persisted patch; this widget
 * subscribes via `useSyncExternalStore` and re-renders the relative time.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { refreshAllInstanceCapabilityWarnings } from "@/lib/ai/agent/team/capability-audit"

// ---- module-level save tracker (singleton) --------------------------------

let lastSavedAt: number | null = null
const listeners = new Set<() => void>()

/** Notify the indicator that a settings patch was just persisted. */
export function markSettingsSaved(): void {
  lastSavedAt = Date.now()
  for (const l of listeners) l()
}

/** Test-only: reset the singleton tracker. */
export function __resetSettingsSaveTrackerForTesting(): void {
  lastSavedAt = null
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): number | null {
  return lastSavedAt
}

export interface SettingsSaveTracker {
  lastSavedAt: number | null
  secondsSince: number | null
}

/**
 * Subscribe to the save tracker. Re-renders on save and on a 5s interval so
 * the relative time stays fresh while the panel is open.
 */
export function useSettingsSaveTracker(): SettingsSaveTracker {
  const saved = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Hold "now" in state (seeded lazily so render stays pure) and let the
  // interval advance it every 5s so "Ns ago" ticks up without a new save.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  return {
    lastSavedAt: saved,
    secondsSince: saved === null ? null : Math.max(0, Math.round((now - saved) / 1000)),
  }
}

export interface SettingsSaveIndicatorProps {
  teamId: string
}

export function SettingsSaveIndicator({ teamId }: SettingsSaveIndicatorProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.saveIndicator")
  const { lastSavedAt: saved, secondsSince } = useSettingsSaveTracker()

  const handleAudit = useCallback(async () => {
    try {
      const result = await refreshAllInstanceCapabilityWarnings()
      const count = result.warningsByTeamId[teamId]?.length ?? 0
      toast.success(t("auditCompleted", { count }))
    } catch {
      toast.error(t("auditUnavailable"))
    }
  }, [t, teamId])

  return (
    <div
      className="flex items-center justify-between gap-2 px-1"
      data-testid="settings-save-indicator"
    >
      <Badge variant="outline" className="text-[10px] font-normal">
        {saved === null
          ? t("unsaved")
          : secondsSince !== null && secondsSince < 2
            ? t("savedJustNow")
            : t("savedSecondsAgo", { seconds: secondsSince ?? 0 })}
      </Badge>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-xs"
        onClick={() => void handleAudit()}
      >
        <ShieldCheckIcon className="size-3.5" />
        {t("auditNow")}
      </Button>
    </div>
  )
}
