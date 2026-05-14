"use client"

/**
 * Per-twin cron card for the Settings tab (M5).
 *
 * Lets the user configure ingest + distill schedules. Saves write back
 * to the `Twin` row via `updateTwin`, then reconcile the scheduler's
 * tasks table via `syncTwinCronToScheduler`. The describe-cron helper
 * surfaces a human-readable preview of each expression so users don't
 * have to interpret cron syntax themselves.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getTwin, updateTwin } from "@/lib/db/twins"
import { describeCronExpression, validateCronExpression } from "@/lib/scheduler/cron-parser"
import { syncTwinCronToScheduler, CRON_PRESETS } from "@/lib/twin/cron/cron-bridge"
import type { TwinCronSettings } from "@/types/twin"

const DEFAULTS: TwinCronSettings = {
  enabled: false,
  ingestSchedule: "",
  distillSchedule: "",
}

export function TwinCronCard({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.cron")
  const live = useLiveQuery(() => getTwin(twinId), [twinId], undefined)
  const liveCron = live?.cron ?? DEFAULTS
  const [draft, setDraft] = useState<TwinCronSettings>(liveCron)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (dirtyRef.current) return
    setDraft(liveCron)
  }, [liveCron])

  const update = (next: TwinCronSettings) => {
    dirtyRef.current = true
    setDraft(next)
  }

  const ingestPreview = useMemo(
    () => describeOrFallback(draft.ingestSchedule),
    [draft.ingestSchedule]
  )
  const distillPreview = useMemo(
    () => describeOrFallback(draft.distillSchedule),
    [draft.distillSchedule]
  )

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateTwin(twinId, { cron: draft })
      const result = await syncTwinCronToScheduler(twinId, draft)
      if (result.invalidExpressions.length > 0) {
        toast.error(t("invalidExpressions", { items: result.invalidExpressions.join("; ") }))
      } else {
        toast.success(t("saved"))
      }
      dirtyRef.current = false
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="twin-cron-card">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        {savedAt ? (
          <span className="text-muted-foreground text-xs">
            {t("savedAt", { when: new Date(savedAt).toLocaleTimeString() })}
          </span>
        ) : null}
      </header>
      <p className="text-muted-foreground text-xs">{t("description")}</p>

      <div className="flex items-center gap-3">
        <Switch
          id={`twin-cron-enabled-${twinId}`}
          checked={draft.enabled}
          onCheckedChange={(v) => update({ ...draft, enabled: v })}
          data-testid="twin-cron-enabled"
        />
        <Label htmlFor={`twin-cron-enabled-${twinId}`} className="text-sm">
          {t("enabledLabel")}
        </Label>
      </div>

      <CronField
        label={t("ingestLabel")}
        value={draft.ingestSchedule}
        onChange={(v) => update({ ...draft, ingestSchedule: v })}
        preview={ingestPreview}
        disabled={!draft.enabled}
        testid="twin-cron-ingest"
      />
      <CronField
        label={t("distillLabel")}
        value={draft.distillSchedule}
        onChange={(v) => update({ ...draft, distillSchedule: v })}
        preview={distillPreview}
        disabled={!draft.enabled}
        testid="twin-cron-distill"
      />

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving}
          data-testid="twin-cron-save"
        >
          {saving ? t("busy") : t("save")}
        </Button>
      </div>
    </Card>
  )
}

interface CronFieldProps {
  label: string
  value: string
  onChange: (next: string) => void
  preview: string
  disabled: boolean
  testid: string
}

function CronField({ label, value, onChange, preview, disabled, testid }: CronFieldProps) {
  const t = useTranslations("twin.cron")
  return (
    <div className="grid gap-1">
      <Label htmlFor={testid}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={testid}
          data-testid={testid}
          className="font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("placeholder")}
          disabled={disabled}
        />
        <select
          aria-label={t("presetAria", { label })}
          className="border-border bg-background h-9 rounded border px-2 text-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value)
          }}
          disabled={disabled}
          data-testid={`${testid}-preset`}
        >
          <option value="">{t("presetHint")}</option>
          {CRON_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <p className="text-muted-foreground text-xs">{preview}</p>
    </div>
  )
}

/**
 * Best-effort human description. Empty / invalid expressions land on
 * obvious placeholder text so the user sees feedback as they type.
 */
function describeOrFallback(expression: string): string {
  const trimmed = expression.trim()
  if (!trimmed) return "(disabled)"
  if (!validateCronExpression(trimmed).valid) return `⚠ ${trimmed} — invalid`
  return describeCronExpression(trimmed)
}
