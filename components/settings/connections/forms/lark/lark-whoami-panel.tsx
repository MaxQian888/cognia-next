"use client"

/**
 * Lark whoami panel — reads the cached `lastWhoamiResult` off the
 * adapter row and renders the bot identity (name + avatar + app_id +
 * tenant + activate-status). "Re-probe" triggers `probeBotIdentity`
 * which round-trips Lark's `/bot/v3/info` and updates the row.
 *
 * Mounted inside the Settings → Adapters → Lark detail panel Config
 * tab so operators can confirm at-a-glance that credentials map to the
 * expected bot.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckCircle2Icon, LoaderIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { isTauri } from "@/lib/tauri"
import { LarkWhoamiError, probeBotIdentity } from "@/lib/connectors/adapters/lark/whoami"

const ACTIVATE_STATUS_KEYS: Record<number, string> = {
  0: "uninitialized",
  1: "offline",
  2: "online",
  3: "stopped",
}

export interface LarkWhoamiPanelProps {
  adapterId: string
}

export function LarkWhoamiPanel({ adapterId }: LarkWhoamiPanelProps) {
  const t = useTranslations("settings.connections.lark.whoami")
  const [probing, setProbing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const desktop = isTauri()

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const onProbe = async () => {
    if (!desktop) return
    setProbing(true)
    setLastError(null)
    try {
      await probeBotIdentity(adapterId)
    } catch (err) {
      const message =
        err instanceof LarkWhoamiError
          ? `${err.larkCode ?? err.httpStatus ?? "?"} — ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      setLastError(message)
    } finally {
      setProbing(false)
    }
  }

  const whoami = row?.lastWhoamiResult
  const lastAt = row?.lastWhoamiAt

  return (
    <Card data-testid="lark-whoami-panel">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{t("title")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onProbe()}
            disabled={!desktop || probing}
            aria-label={whoami ? t("reprobeButton") : t("probeButton")}
            data-testid="lark-whoami-reprobe"
          >
            {probing ? (
              <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
            )}
            {whoami ? t("reprobeButton") : t("probeButton")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {whoami ? (
          <div className="flex items-start gap-3">
            <Avatar className="h-12 w-12">
              {whoami.botAvatar ? (
                <AvatarImage src={whoami.botAvatar} alt={whoami.botName} />
              ) : null}
              <AvatarFallback className="text-sm">
                {whoami.botName?.slice(0, 2).toUpperCase() ?? "??"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold truncate">{whoami.botName}</span>
                {typeof whoami.activateStatus === "number" && (
                  <Badge
                    variant={whoami.activateStatus === 2 ? "default" : "outline"}
                    className="text-xs"
                  >
                    {ACTIVATE_STATUS_KEYS[whoami.activateStatus] ??
                      `status:${whoami.activateStatus}`}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>
                  <span className="font-mono">{whoami.appId}</span>
                </div>
                <div>
                  <span>open_id: </span>
                  <span className="font-mono break-all">{whoami.openId}</span>
                </div>
                {whoami.tenantKey && (
                  <div>
                    <span>{t("tenant")}: </span>
                    <span className="font-mono">{whoami.tenantKey}</span>
                  </div>
                )}
                {whoami.scopes && whoami.scopes.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {whoami.scopes.map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              {typeof lastAt === "number" && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
                  <CheckCircle2Icon className="h-3 w-3 text-emerald-500" />
                  <span>{t("lastProbeAt", { time: new Date(lastAt).toLocaleString() })}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="lark-whoami-empty">
            {t("unknown")}
          </p>
        )}
        {lastError && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="lark-whoami-error"
          >
            <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 break-words">
              <div className="font-medium">{t("probeFailed")}</div>
              <div className="font-mono">{lastError}</div>
            </div>
          </div>
        )}
        {!desktop && (
          <p className="text-xs text-muted-foreground" data-testid="lark-whoami-desktop-only">
            {t("requiresDesktop")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
