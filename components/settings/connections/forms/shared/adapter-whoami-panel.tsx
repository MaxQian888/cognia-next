"use client"

/**
 * Generic adapter identity panel (im-refactored-crayon).
 *
 * Used by every platform except Lark — Lark has its own richer panel
 * under `forms/lark/lark-whoami-panel.tsx` that surfaces scopes +
 * tenant + activate-status. This generic panel branches by the row's
 * `type` to call the right HTTP probe:
 *
 *   - telegram → `/getMe`
 *   - discord  → `/users/@me`
 *   - slack    → `auth.test`
 *   - onebot   → no HTTP probe (bot connects TO us via reverse-WS;
 *               identity is whatever the operator configured in
 *               `settings.selfBotUin`). The button is hidden.
 *
 * Probe results all land in `adapterInstances.lastWhoamiResult` so the
 * panel can render the cached snapshot regardless of which probe wrote
 * it.
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
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { isTauri } from "@/lib/tauri"
import { probeTelegramIdentity, TelegramWhoamiError } from "@/lib/connectors/whoami/telegram-whoami"
import { probeDiscordIdentity, DiscordWhoamiError } from "@/lib/connectors/whoami/discord-whoami"
import { probeSlackIdentity, SlackWhoamiError } from "@/lib/connectors/whoami/slack-whoami"

export interface AdapterWhoamiPanelProps {
  adapterId: string
  /** The platform discriminator from `AdapterInstanceRow.type`. */
  platform: PlatformKind
}

async function dispatchProbe(adapterId: string, platform: PlatformKind): Promise<void> {
  switch (platform) {
    case "telegram":
      await probeTelegramIdentity(adapterId)
      return
    case "discord":
      await probeDiscordIdentity(adapterId)
      return
    case "slack":
      await probeSlackIdentity(adapterId)
      return
    case "onebot":
      // No reverse-WS probe — identity is what the operator entered in
      // `settings.selfBotUin`. The panel renders that statically without
      // hitting the network.
      return
    default:
      throw new Error(`No whoami probe wired for platform: ${platform}`)
  }
}

function probeErrorMessage(err: unknown): string {
  if (err instanceof TelegramWhoamiError) {
    return `${err.httpStatus ?? "?"} — ${err.message}`
  }
  if (err instanceof DiscordWhoamiError) {
    return `${err.httpStatus ?? "?"} — ${err.message}`
  }
  if (err instanceof SlackWhoamiError) {
    return `${err.httpStatus ?? "?"} — ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function AdapterWhoamiPanel({ adapterId, platform }: AdapterWhoamiPanelProps) {
  const t = useTranslations("settings.connections.lark.whoami")
  const [probing, setProbing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const desktop = isTauri()
  const probeSupported = platform !== "onebot"

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const onProbe = async () => {
    if (!desktop || !probeSupported) return
    setProbing(true)
    setLastError(null)
    try {
      await dispatchProbe(adapterId, platform)
    } catch (err) {
      setLastError(probeErrorMessage(err))
    } finally {
      setProbing(false)
    }
  }

  const whoami = row?.lastWhoamiResult
  const lastAt = row?.lastWhoamiAt
  // OneBot has no probe — surface the operator-entered self UIN so the
  // panel still has something to display.
  const fallbackBotName =
    !whoami && platform === "onebot"
      ? (row?.settings as { selfBotUin?: string } | undefined)?.selfBotUin
      : undefined

  return (
    <Card data-testid="adapter-whoami-panel" data-platform={platform}>
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{t("title")}</span>
          {probeSupported && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onProbe()}
              disabled={!desktop || probing}
              aria-label={whoami ? t("reprobeButton") : t("probeButton")}
              data-testid="adapter-whoami-reprobe"
            >
              {probing ? (
                <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
              )}
              {whoami ? t("reprobeButton") : t("probeButton")}
            </Button>
          )}
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
                <Badge variant="outline" className="text-xs">
                  {platform}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>
                  <span>app: </span>
                  <span className="font-mono">{whoami.appId}</span>
                </div>
                <div>
                  <span>id: </span>
                  <span className="font-mono break-all">{whoami.openId}</span>
                </div>
                {whoami.tenantKey && (
                  <div>
                    <span>{t("tenant")}: </span>
                    <span className="font-mono">{whoami.tenantKey}</span>
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
        ) : fallbackBotName ? (
          <div className="flex items-start gap-3" data-testid="adapter-whoami-onebot-fallback">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="text-sm">QQ</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold truncate">{fallbackBotName}</span>
                <Badge variant="outline" className="text-xs">
                  onebot
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.has("onebotNoProbe") ? t("onebotNoProbe") : t("unknown")}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="adapter-whoami-empty">
            {t("unknown")}
          </p>
        )}
        {lastError && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="adapter-whoami-error"
          >
            <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 break-words">
              <div className="font-medium">{t("probeFailed")}</div>
              <div className="font-mono">{lastError}</div>
            </div>
          </div>
        )}
        {!desktop && probeSupported && (
          <p className="text-xs text-muted-foreground" data-testid="adapter-whoami-desktop-only">
            {t("requiresDesktop")}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
