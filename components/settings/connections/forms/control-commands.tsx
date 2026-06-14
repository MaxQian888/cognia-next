"use client"

/**
 * ControlCommands — shared, self-managing section for every IM adapter's
 * detail panel. Reads `AdapterInstanceRow.controlCommands` via `useLiveQuery`
 * and writes it through `updateAdapterInstance`, the exact pattern
 * `HelpAndWelcome` / `LarkAtStrategy` use. Mounted once in `config-detail.tsx`
 * so every platform gets it without per-form wiring.
 *
 * Fields (control-plane permission gate, enforced in
 * `lib/connectors/commands/dispatch.ts`):
 *   - enabled (Switch) — master switch. Defaults to ON (row stores
 *     `undefined` ⇒ enabled; flip OFF to disable ALL in-chat control commands
 *     on this adapter).
 *   - mode (Select) — everyone | private-only (default) | allowlist. Only
 *     state-changing commands are gated; read-only commands (/status /help
 *     /sessions /dir /commands) always pass.
 *   - allowedUserIds (Textarea, one per line) — shown only in allowlist mode.
 *
 * Persistence is immediate on each change (toggles/select) and on blur for
 * the allowlist textarea (so we don't write per keystroke).
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export type ControlCommandsMode = "everyone" | "private-only" | "allowlist"

export interface ControlCommandsValue {
  enabled: boolean
  mode: ControlCommandsMode
  allowedUserIds: string[]
}

export interface ControlCommandsProps {
  adapterId: string
}

/** Parse a textarea (one id per line) into a trimmed, non-empty list. */
export function parseUserIds(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Read the row's controlCommands into a fully-defaulted value. */
export function readControlCommands(row: AdapterInstanceRow | undefined): ControlCommandsValue {
  const cc = row?.controlCommands
  return {
    enabled: cc?.enabled !== false,
    mode: cc?.mode ?? "private-only",
    allowedUserIds: cc?.allowedUserIds ?? [],
  }
}

export function ControlCommands({ adapterId }: ControlCommandsProps) {
  const t = useTranslations("settings.connections.controlCommands")
  const [saving, setSaving] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const value = readControlCommands(row)
  const [idsText, setIdsText] = useState("")

  // Seed the allowlist textarea the first time the row resolves for this
  // adapter (re-seed if the adapter id changes). The `seededFor` guard stops
  // a later liveQuery refresh from clobbering an in-progress edit.
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!row) return
    if (seededFor.current === adapterId) return
    seededFor.current = adapterId
    setIdsText((row.controlCommands?.allowedUserIds ?? []).join("\n"))
  }, [adapterId, row])

  const persist = async (patch: Partial<ControlCommandsValue>): Promise<void> => {
    setSaving(true)
    try {
      const merged: ControlCommandsValue = { ...value, ...patch }
      await updateAdapterInstance(adapterId, {
        controlCommands: {
          enabled: merged.enabled,
          mode: merged.mode,
          ...(merged.mode === "allowlist" ? { allowedUserIds: merged.allowedUserIds } : {}),
        },
      })
    } finally {
      setSaving(false)
    }
  }

  const onToggleEnabled = (v: boolean) => void persist({ enabled: v })
  const onModeChange = (m: ControlCommandsMode) => void persist({ mode: m })
  const onIdsBlur = () => void persist({ allowedUserIds: parseUserIds(idsText) })

  return (
    <Card data-testid="control-commands">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 space-y-0.5">
            <Label htmlFor="control-commands-enabled" className="cursor-pointer">
              {t("enableLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>
          </div>
          <Switch
            id="control-commands-enabled"
            data-testid="control-commands-enabled"
            checked={value.enabled}
            onCheckedChange={onToggleEnabled}
            disabled={saving}
            aria-label={t("enableAria")}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="control-commands-mode">{t("modeLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("modeHelp")}</p>
          <Select value={value.mode} onValueChange={(v) => onModeChange(v as ControlCommandsMode)}>
            <SelectTrigger
              id="control-commands-mode"
              data-testid="control-commands-mode"
              disabled={saving}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">{t("modeEveryone")}</SelectItem>
              <SelectItem value="private-only">{t("modePrivateOnly")}</SelectItem>
              <SelectItem value="allowlist">{t("modeAllowlist")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {value.mode === "allowlist" && (
          <div className="space-y-1">
            <Label htmlFor="control-commands-ids">{t("allowlistLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("allowlistHelp")}</p>
            <Textarea
              id="control-commands-ids"
              data-testid="control-commands-ids"
              rows={3}
              value={idsText}
              onChange={(e) => setIdsText(e.target.value)}
              onBlur={onIdsBlur}
              disabled={saving}
              placeholder={t("allowlistPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
