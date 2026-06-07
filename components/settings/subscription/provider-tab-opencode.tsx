"use client"

// OpenCode provider tab — flat. Account list (Zen/Go-keyed accounts), a
// preset picker (relay/mirror endpoints in front of the managed gateway,
// parity with Anthropic/Codex), and an inline read-only discovery card
// listing the whitelisted sub-providers configured in
// `~/.local/share/opencode/auth.json` (never written back).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

import { AccountList } from "./account-list"
import { OpencodeAddAccountDialog } from "./add-account-dialog/opencode"
import { PresetPicker } from "./preset-picker"

import { useOpencodeDiscovery } from "@/lib/subscription/opencode/discovery"
import { OPENCODE_WHITELIST } from "@/types/subscription"

export function ProviderTabOpencode() {
  const t = useTranslations("subscription.opencode")
  const tDiscovery = useTranslations("subscription.opencode.discovery")
  const tZen = useTranslations("subscription.opencode.zen")
  const [addOpen, setAddOpen] = useState(false)

  const { discovered, loading, error, reload } = useOpencodeDiscovery()

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <AccountList
        provider="opencode"
        onAdd={() => setAddOpen(true)}
        secondaryAction={
          <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>
            {tZen("addKey")}
          </Button>
        }
      />

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
                    <Badge variant="outline" className="text-[10px]">
                      {kindLabel(entry.kind, tDiscovery)}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                Whitelist: <code className="font-mono">{OPENCODE_WHITELIST.join(", ")}</code>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <OpencodeAddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
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
