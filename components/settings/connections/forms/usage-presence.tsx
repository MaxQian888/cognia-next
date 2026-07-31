"use client"

/**
 * Cross-provider "Usage status" (token-usage presence) settings. Self-managing
 * — reads the adapter row via `useLiveQuery` and writes the row-level
 * `presence` config through `updateAdapterInstance`, same pattern as
 * `HelpAndWelcome`. Mounted once in the adapter detail panel.
 *
 * After every save it reconciles the recurring scheduler task via
 * `syncUsagePresenceSchedule` (create / retune / delete), so the toggle is
 * the single switch the operator touches.
 *
 * The badge tier is only offered on platforms that declare the
 * `presence.status` capability (Lark 系统状态, Slack profile status, Discord
 * bot presence); everywhere else the card tier remains available.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
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
import { getPlatformCapabilities } from "@/lib/connectors/platform-capabilities"
import { hasCapability } from "@/types/connectors/capability"
import { syncUsagePresenceSchedule } from "@/lib/connectors/presence/usage-status-runner"
import {
  DEFAULT_USAGE_PRESENCE_CONFIG,
  type UsagePresenceConfig,
  type UsagePresenceMode,
  type UsagePresenceWindow,
} from "@/types/connectors/presence"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface UsagePresenceProps {
  adapterId: string
}

/** Parse a textarea (one user id per line) into a trimmed, non-empty list. */
export function parseUserIdLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

export function UsagePresence({ adapterId }: UsagePresenceProps) {
  const t = useTranslations("settings.connections.usagePresence")
  const [saving, setSaving] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const config: UsagePresenceConfig = { ...DEFAULT_USAGE_PRESENCE_CONFIG, ...row?.presence }
  const supportsBadge = row
    ? hasCapability(getPlatformCapabilities(row.type), "presence.status")
    : false

  const [targetsText, setTargetsText] = useState("")
  const [conversationKey, setConversationKey] = useState("")
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!row) return
    if (seededFor.current === adapterId) return
    seededFor.current = adapterId
    setTargetsText((row.presence?.targetUserIds ?? []).join("\n"))
    setConversationKey(row.presence?.cardConversationKey ?? "")
  }, [adapterId, row])

  const save = async (patch: Partial<UsagePresenceConfig>) => {
    const next: UsagePresenceConfig = { ...config, ...patch }
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { presence: next })
      await syncUsagePresenceSchedule(adapterId, next)
    } finally {
      setSaving(false)
    }
  }

  const showCardFields = config.mode === "card" || config.mode === "both"
  const showBadgeFields = supportsBadge && (config.mode === "badge" || config.mode === "both")

  return (
    <Card data-testid="usage-presence">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 space-y-0.5">
            <Label htmlFor="usage-presence-enabled" className="cursor-pointer">
              {t("enableLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>
          </div>
          <Switch
            id="usage-presence-enabled"
            data-testid="usage-presence-enabled"
            checked={config.enabled}
            onCheckedChange={(v) => void save({ enabled: v })}
            disabled={saving}
          />
        </div>

        {config.enabled ? (
          <>
            <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
              <div className="space-y-1">
                <Label>{t("modeLabel")}</Label>
                <Select
                  value={supportsBadge ? config.mode : "card"}
                  onValueChange={(v) => void save({ mode: v as UsagePresenceMode })}
                  disabled={saving}
                >
                  <SelectTrigger data-testid="usage-presence-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {supportsBadge ? <SelectItem value="badge">{t("modeBadge")}</SelectItem> : null}
                    <SelectItem value="card">{t("modeCard")}</SelectItem>
                    {supportsBadge ? <SelectItem value="both">{t("modeBoth")}</SelectItem> : null}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>{t("windowLabel")}</Label>
                <Select
                  value={config.window}
                  onValueChange={(v) => void save({ window: v as UsagePresenceWindow })}
                  disabled={saving}
                >
                  <SelectTrigger data-testid="usage-presence-window">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">{t("windowToday")}</SelectItem>
                    <SelectItem value="7d">{t("window7d")}</SelectItem>
                    <SelectItem value="30d">{t("window30d")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="usage-presence-interval">{t("intervalLabel")}</Label>
                <Input
                  id="usage-presence-interval"
                  data-testid="usage-presence-interval"
                  type="number"
                  min={1}
                  value={config.intervalMinutes}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    void save({ intervalMinutes: Number.isFinite(n) ? Math.max(1, n) : 5 })
                  }}
                  disabled={saving}
                />
              </div>
            </div>

            {showBadgeFields ? (
              <div className="space-y-1">
                <Label htmlFor="usage-presence-targets">{t("targetsLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("targetsHelp")}</p>
                <Textarea
                  id="usage-presence-targets"
                  data-testid="usage-presence-targets"
                  rows={3}
                  value={targetsText}
                  onChange={(e) => setTargetsText(e.target.value)}
                  onBlur={() => void save({ targetUserIds: parseUserIdLines(targetsText) })}
                  disabled={saving}
                />
              </div>
            ) : null}

            {showCardFields ? (
              <div className="space-y-1">
                <Label htmlFor="usage-presence-conversation">{t("conversationLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("conversationHelp")}</p>
                <Input
                  id="usage-presence-conversation"
                  data-testid="usage-presence-conversation"
                  value={conversationKey}
                  onChange={(e) => setConversationKey(e.target.value)}
                  onBlur={() =>
                    void save({ cardConversationKey: conversationKey.trim() || undefined })
                  }
                  disabled={saving}
                />
              </div>
            ) : null}

            {row?.presenceState?.lastError ? (
              <p className="text-xs text-destructive" data-testid="usage-presence-error">
                {t("lastError", { error: row.presenceState.lastError })}
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
