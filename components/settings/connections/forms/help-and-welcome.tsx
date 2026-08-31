"use client"

/**
 * Cross-provider "Help & Welcome card" settings (shared across every IM
 * adapter). Self-managing — reads the adapter row via `useLiveQuery` and
 * writes the three row-level fields through `updateAdapterInstance`, the
 * exact pattern `InboundActivationEditor` / `LarkWhitelistEditor` use. Mounted once
 * in the adapter detail panel (`config-detail.tsx`) so every platform gets
 * it without per-form wiring.
 *
 * Fields:
 *   - welcomeCardEnabled (Switch) — proactive welcome on bot-join / first
 *     inbound. Defaults to on (the row stores `undefined` ⇒ enabled).
 *   - helpTriggers (Textarea, one per line) — message texts that serve a
 *     help card instead of an AI turn. Empty ⇒ the built-in defaults
 *     (`/help`, `帮助`).
 *   - welcomeText (Textarea) — optional custom welcome intro.
 *
 * Persistence on blur for the text areas (so we don't write on every
 * keystroke); the toggle persists immediately.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { DEFAULT_HELP_TRIGGERS } from "@/lib/connectors/help/help-dispatch"

export interface HelpAndWelcomeProps {
  adapterId: string
}

/** Parse a textarea (one trigger per line) into a trimmed, non-empty list. */
export function parseTriggerLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

export function HelpAndWelcome({ adapterId }: HelpAndWelcomeProps) {
  const t = useTranslations("settings.connections.helpAndWelcome")
  const [saving, setSaving] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const enabled = row?.welcomeCardEnabled ?? true
  const [triggersText, setTriggersText] = useState("")
  const [welcomeText, setWelcomeText] = useState("")

  // Seed local editor state the first time the row resolves for this adapter
  // (and re-seed if the adapter id changes). The `seededFor` guard prevents
  // a later liveQuery refresh from clobbering an in-progress edit.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!row) return
    if (seededFor.current === adapterId) return
    seededFor.current = adapterId
    setTriggersText((row.helpTriggers ?? []).join("\n"))
    setWelcomeText(row.welcomeText ?? "")
  }, [adapterId, row])

  const onToggle = async (value: boolean) => {
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { welcomeCardEnabled: value })
    } finally {
      setSaving(false)
    }
  }

  const onTriggersBlur = async () => {
    const parsed = parseTriggerLines(triggersText)
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { helpTriggers: parsed })
    } finally {
      setSaving(false)
    }
  }

  const onWelcomeTextBlur = async () => {
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { welcomeText: welcomeText.trim() })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="help-and-welcome">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 space-y-0.5">
            <Label htmlFor="help-welcome-enabled" className="cursor-pointer">
              {t("enableCardLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("enableCardHelp")}</p>
          </div>
          <Switch
            id="help-welcome-enabled"
            data-testid="help-welcome-enabled"
            checked={enabled}
            onCheckedChange={(v) => void onToggle(v)}
            disabled={saving}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="help-welcome-triggers">{t("triggersLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("triggersHelp", { defaults: DEFAULT_HELP_TRIGGERS.join(", ") })}
          </p>
          <Textarea
            id="help-welcome-triggers"
            data-testid="help-welcome-triggers"
            rows={3}
            value={triggersText}
            placeholder={DEFAULT_HELP_TRIGGERS.join("\n")}
            onChange={(e) => setTriggersText(e.target.value)}
            onBlur={() => void onTriggersBlur()}
            disabled={saving}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="help-welcome-text">{t("welcomeTextLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("welcomeTextHelp")}</p>
          <Textarea
            id="help-welcome-text"
            data-testid="help-welcome-text"
            rows={3}
            value={welcomeText}
            placeholder={t("welcomeTextPlaceholder")}
            onChange={(e) => setWelcomeText(e.target.value)}
            onBlur={() => void onWelcomeTextBlur()}
            disabled={saving}
          />
        </div>
      </CardContent>
    </Card>
  )
}
