// ADR-0028 "lite" — workspace confinement toggle.
//
// `AppSettings.workspaceConfinementEnabled` is read by
// `lib/claude/build-options.ts:resolveSendOptions` to decide whether the
// sidecar built-in file/bash tools are confined to the active workspace roots.
// It defaults to TRUE (confined out of the box): out-of-root mutator calls
// escalate to approval and credential paths hard-deny. This card is the
// deliberate opt-out. Independent of the heavy OS sandbox (`sandboxDefaultEnabled`)
// — when that is active it takes over and this layer steps aside.

"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"

export function WorkspaceConfinementCard() {
  const t = useTranslations("settings.sandbox.workspaceConfinement")
  const settings = useSettingsStore((s) => s.settings)
  const switchId = useId()
  // Default ON — confined unless the user explicitly opts out.
  const enabled = settings?.workspaceConfinementEnabled ?? true

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={switchId} className="text-sm font-medium">
            {t("label")}
          </Label>
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={(checked) =>
              void saveSettings({ workspaceConfinementEnabled: checked })
            }
            data-testid="workspace-confinement-switch"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  )
}
