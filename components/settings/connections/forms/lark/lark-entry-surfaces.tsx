"use client"

/**
 * Lark entry-surface operations card (plan 2026-07-24 P3-P6, Commit 6).
 *
 * One place for the gray-release levers this epic added to a Lark adapter:
 *   - the web entry base URL external links are built on,
 *   - per-adapter feature-flag overrides (principal registry + entry
 *     surfaces; unset falls back to env/global defaults, all off),
 *   - the callback-authorization mode (off / audit / enforce),
 *   - the reconciled Chat Tab / group-menu surface rows with a resync
 *     button driving `resyncLarkChatSurfaces`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getDb } from "@/lib/db/schema"
import { patchAdapterInstanceSettings } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { resyncLarkChatSurfaces } from "@/lib/connectors/adapters/lark/surface-sweep"
import { removeDisabledLarkSurfaces } from "@/lib/connectors/adapters/lark/surface-removal"
import {
  isLarkFeatureEnabled,
  type LarkBooleanFeatureFlag,
  type LarkStrictCallbackAuthorizationMode,
  getLarkStrictCallbackAuthorizationMode,
} from "@/lib/connectors/feature-flags"
import type { AdapterInstanceRow, LarkChatSurfaceRow } from "@/lib/db/connector-types"

const ENTRY_FLAGS: LarkBooleanFeatureFlag[] = [
  "larkPrincipalRegistry",
  "larkWebSso",
  "larkChatTab",
  "larkGroupMenu",
  "larkNativeSlash",
  "larkMessageShortcut",
  "larkPlusMenu",
]

const STRICT_MODES: LarkStrictCallbackAuthorizationMode[] = ["off", "audit", "enforce"]

const STATUS_BADGE_VARIANT: Record<
  LarkChatSurfaceRow["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  synced: "default",
  pending: "secondary",
  rebuild_required: "secondary",
  error: "destructive",
  // Terminal until reconfigured — destructive so a missing scope is not
  // mistaken for a transient error that will clear itself.
  blocked: "destructive",
  removed: "outline",
}

export interface LarkEntrySurfacesProps {
  adapterId: string
}

export function LarkEntrySurfaces({ adapterId }: LarkEntrySurfacesProps) {
  const t = useTranslations("settings.connections.lark.entrySurfaces")
  const [webBaseDraft, setWebBaseDraft] = useState<{ adapterId: string; value: string } | null>(
    null
  )
  const [resyncState, setResyncState] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | { phase: "done"; synced: number; errors: number; skipped: number }
    | { phase: "failed" }
  >({ phase: "idle" })

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const surfaces =
    useLiveQuery<LarkChatSurfaceRow[]>(
      () =>
        typeof window === "undefined"
          ? Promise.resolve([])
          : getDb().larkChatSurfaces.where("adapterId").equals(adapterId).toArray(),
      [adapterId]
    ) ?? []

  const settings = row?.settings ?? {}
  const webBase = typeof settings.webEntryBaseUrl === "string" ? settings.webEntryBaseUrl : ""

  const patchSettings = (patch: Record<string, unknown>) =>
    patchAdapterInstanceSettings(adapterId, patch)

  const strictMode = getLarkStrictCallbackAuthorizationMode(row ?? undefined)

  const surfaceCtx = {
    adapterId,
    resolveCreds: async () => {
      const [appId, appSecret] = await Promise.all([
        connectorsKeyringGet(adapterId, "appId"),
        connectorsKeyringGet(adapterId, "appSecret"),
      ])
      return { appId: appId ?? "", appSecret: appSecret ?? "" }
    },
  }

  const runResync = async () => {
    setResyncState({ phase: "running" })
    try {
      const counts = await resyncLarkChatSurfaces(surfaceCtx)
      setResyncState({ phase: "done", ...counts })
    } catch {
      setResyncState({ phase: "failed" })
    }
  }

  /**
   * Turning a surface flag off must also take the published tab / menu down.
   * Leaving it up would keep a public entry point live in every chat after the
   * operator decided to withdraw it — the flag only stops us re-syncing it.
   */
  const patchSurfaceFlag = async (flag: LarkBooleanFeatureFlag, checked: boolean) => {
    await patchSettings({ [flag]: checked })
    if (checked) return
    await removeDisabledLarkSurfaces(surfaceCtx).catch(() => undefined)
  }

  return (
    <Card data-testid="lark-entry-surfaces">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="lark-web-base" className="text-xs">
            {t("webBaseLabel")}
          </Label>
          <Input
            id="lark-web-base"
            value={webBaseDraft?.adapterId === adapterId ? webBaseDraft.value : webBase}
            disabled={!row}
            placeholder={t("webBasePlaceholder")}
            onChange={(e) => setWebBaseDraft({ adapterId, value: e.target.value })}
            onBlur={(e) => {
              const next = e.target.value.trim()
              if (next !== webBase) {
                void patchSettings({ webEntryBaseUrl: next || undefined }).then(
                  () => {
                    setWebBaseDraft((current) =>
                      current?.adapterId === adapterId && current.value.trim() === next
                        ? null
                        : current
                    )
                  },
                  () => {
                    // Keep the user's draft visible for a retry; the stored
                    // value was not changed and the rejection is handled.
                  }
                )
              } else {
                setWebBaseDraft(null)
              }
            }}
            data-testid="lark-web-base-input"
          />
          <p className="text-xs text-muted-foreground">{t("webBaseHelp")}</p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t("flagsLabel")}</Label>
          <div className="space-y-2">
            {ENTRY_FLAGS.map((flag) => (
              <div key={flag} className="flex items-center justify-between gap-2">
                <span className="text-xs">{t(`flag.${flag}`)}</span>
                <Switch
                  checked={isLarkFeatureEnabled(flag, row ?? undefined)}
                  onCheckedChange={(checked) =>
                    flag === "larkChatTab" || flag === "larkGroupMenu"
                      ? void patchSurfaceFlag(flag, checked)
                      : void patchSettings({ [flag]: checked })
                  }
                  aria-label={t(`flag.${flag}`)}
                  data-testid={`lark-flag-${flag}`}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("flagsHelp")}</p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">{t("strictAuthLabel")}</Label>
          <div className="flex gap-1.5" role="group" aria-label={t("strictAuthLabel")}>
            {STRICT_MODES.map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={strictMode === mode ? "default" : "outline"}
                aria-pressed={strictMode === mode}
                onClick={() => void patchSettings({ larkStrictCallbackAuthorization: mode })}
                data-testid={`lark-strict-auth-${mode}`}
              >
                {t(`strictAuth.${mode}`)}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("strictAuthHelp")}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{t("surfacesLabel")}</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runResync()}
              disabled={resyncState.phase === "running"}
              data-testid="lark-surfaces-resync"
            >
              <RefreshCwIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
              {resyncState.phase === "running" ? t("resyncing") : t("resync")}
            </Button>
          </div>
          {resyncState.phase === "done" && (
            <p className="text-xs text-muted-foreground" role="status">
              {t("resyncDone", {
                synced: resyncState.synced,
                errors: resyncState.errors,
                skipped: resyncState.skipped,
              })}
            </p>
          )}
          {resyncState.phase === "failed" && (
            <p className="text-xs text-destructive" role="status">
              {t("resyncFailed")}
            </p>
          )}
          {surfaces.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t("surfacesEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {surfaces.map((surface) => (
                <li
                  key={`${surface.chatId}:${surface.surfaceType}`}
                  className="flex items-center justify-between gap-2 text-xs"
                  data-testid={`lark-surface-${surface.chatId}-${surface.surfaceType}`}
                >
                  <span className="font-mono break-all">
                    {surface.chatId} · {surface.surfaceType}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {surface.lastError && (
                      <span className="text-muted-foreground max-w-48 truncate">
                        {surface.lastError}
                      </span>
                    )}
                    <Badge
                      variant={STATUS_BADGE_VARIANT[surface.status]}
                      aria-label={t("statusAria")}
                    >
                      {t(`status.${surface.status}`)}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
