"use client"

// OpenCode provider tab: quota guidance, routing presets, and the inline
// discovery card. Managed account CRUD lives in Account Center, but adopting a
// discovered `auth.json` pointer stays here because Account Center has no view
// of that file and this row is the capability's only entry point.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { SettingsAlert } from "@/components/settings/common/settings-section"
import { isTauri } from "@/lib/tauri"

import { PresetPicker } from "./preset-picker"
import { ProviderQuotaPanel } from "./provider-quota-panel"

import { useOpencodeDiscovery } from "@/lib/subscription/opencode/discovery"
import { opencodeAdoptDiscovered } from "@/lib/subscription/core/transport"
import { OPENCODE_WHITELIST } from "@/types/subscription"
import { toast } from "@/components/ui/sonner"

export function ProviderTabOpencode() {
  const t = useTranslations("subscription.opencode")
  const tDiscovery = useTranslations("subscription.opencode.discovery")
  const [adopting, setAdopting] = useState<string | null>(null)
  const { discovered, loading, error, reload } = useOpencodeDiscovery()

  const adopt = async (subProvider: string) => {
    setAdopting(subProvider)
    try {
      await opencodeAdoptDiscovered(subProvider, null)
      toast.success(tDiscovery("adoptSuccess", { subProvider }))
    } catch (err) {
      toast.error(
        tDiscovery("adoptFailed", { error: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setAdopting(null)
    }
  }

  // Accounts and discovery both read the OS keychain / local auth.json through
  // Tauri commands, so nothing on this tab can work in the browser.
  if (!isTauri()) {
    return <SettingsAlert title={t("title")}>{t("webModeBanner")}</SettingsAlert>
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {/* OpenCode Zen/Go has NO API-key-queryable balance/usage endpoint —
          billing gates run server-side inside the inference handler and the
          numbers are only visible in the session-authenticated Console
          (verified against sst/opencode packages/console zen/util/handler.ts,
          2026-07-11). This precedes the panel: rendering a permanently empty
          gauge with a dead Refresh button first, and only then explaining it,
          reads as a bug. */}
      <p className="text-xs text-muted-foreground">
        {t("quotaConsoleOnly")}{" "}
        <a
          href="https://opencode.ai/docs/zen"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t("quotaConsoleLink")}
        </a>
      </p>

      <ProviderQuotaPanel provider="opencode" />

      <PresetPicker provider="opencode" />

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm">{tDiscovery("title")}</Label>
              <p className="text-xs text-muted-foreground">{tDiscovery("description")}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
              <RefreshCwIcon className="mr-2 size-3" />
              {tDiscovery("rescan")}
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {loading ? (
            <p className="text-xs text-muted-foreground">
              <Loader2Icon className="mr-2 inline size-3 animate-spin" />
              {tDiscovery("scanning")}
            </p>
          ) : !discovered || discovered.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tDiscovery("empty")}</p>
          ) : (
            <div className="space-y-2 text-xs">
              <div>
                <span className="text-muted-foreground">{tDiscovery("pathLabel")}: </span>
                <span className="font-mono break-all">{discovered.authJsonPath}</span>
              </div>
              <ul className="space-y-1.5">
                {discovered.entries.map((entry) => (
                  <li
                    key={entry.subProvider}
                    className="flex items-center justify-between gap-2 rounded border bg-muted/30 px-2.5 py-1.5"
                  >
                    <span className="font-medium">{entry.subProvider}</span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {kindLabel(entry.kind, tDiscovery)}
                      </Badge>
                      {/* Adopting links the discovered `auth.json` pointer into
                          the vault. Account Center owns account CRUD but has no
                          view of this file, so this row is the only reachable
                          entry point the capability has. */}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        disabled={adopting !== null}
                        onClick={() => void adopt(entry.subProvider)}
                        data-testid={`opencode-adopt-${entry.subProvider}`}
                      >
                        {adopting === entry.subProvider && (
                          <Loader2Icon className="mr-1 size-3 animate-spin" />
                        )}
                        {tDiscovery("adopt")}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                {tDiscovery("whitelistLabel")}:{" "}
                <code className="font-mono">{OPENCODE_WHITELIST.join(", ")}</code>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function kindLabel(
  kind: string,
  t: ReturnType<typeof useTranslations<"subscription.opencode.discovery">>
): string {
  switch (kind) {
    case "api-key":
      return t("kindApiKey")
    case "oauth":
      return t("kindOauth")
    default:
      return t("kindUnknown")
  }
}
