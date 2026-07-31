"use client"

/**
 * Mobile Computer Use page. Two parts:
 *   • Master toggle (`mobileComputerUseEnabled`) — when off, mobile-initiated
 *     turns refuse to enter a computer-use loop regardless of per-character
 *     `enableComputerUse`.
 *   • The desktop `<AutomationSection>` for fine-grained permission,
 *     whitelist, audit, and inspector tabs (responsive — embeds cleanly
 *     in the mobile shell).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorIcon } from "lucide-react"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { AutomationSection } from "@/components/settings/automation/automation-section"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"

export default function MobileComputerUsePage() {
  const t = useTranslations("mobile.me")
  const tCu = useTranslations("mobile.me.computerUse")

  const enabled = useSettingsStore((s) => s.settings?.mobileComputerUseEnabled ?? false)
  const update = useSettingsPatch()
  // Persisting the flag is an async round-trip (settings store + outbound RPC);
  // surface it so a slow write doesn't look like a dead toggle.
  const [pending, setPending] = useState(false)

  const toggle = async (next: boolean) => {
    setPending(true)
    try {
      await update({ mobileComputerUseEnabled: next })
    } finally {
      setPending(false)
    }
  }

  return (
    <SubPageShell
      title={t("computerUseRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-computer-use-page"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MonitorIcon className="size-4" aria-hidden="true" />
              {tCu("masterToggleTitle")}
            </CardTitle>
            <CardDescription className="text-xs">{tCu("masterToggleDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4 px-4 pb-3">
            <div className="text-xs text-muted-foreground">
              {enabled ? tCu("masterStateOn") : tCu("masterStateOff")}
            </div>
            <div className="flex items-center gap-2">
              {pending && (
                <Loader2Icon
                  className="size-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                  data-testid="computer-use-saving"
                />
              )}
              <Switch
                checked={enabled}
                disabled={pending}
                onCheckedChange={(v) => void toggle(v)}
                aria-label={tCu("masterToggleAria")}
                data-testid="computer-use-master-switch"
              />
            </div>
          </CardContent>
        </Card>
        <AutomationSection />
      </div>
    </SubPageShell>
  )
}
