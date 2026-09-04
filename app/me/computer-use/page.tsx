"use client"

/**
 * Mobile Computer Use page. Two things a phone can actually do:
 *
 *   • Master toggle (`mobileComputerUseEnabled`). When off, mobile-initiated
 *     turns refuse to enter a computer-use loop regardless of per-character
 *     `enableComputerUse`. This is an app setting, so it writes from here.
 *   • Supervise the connected host: engine state, what it decided, and the
 *     halt. Those four reads and that one write cross the companion RPC plane.
 *
 * It used to embed the desktop `<AutomationSection>` instead, whose every tab
 * gates on `isTauri()`. In the Capacitor shell that is false, so the page was
 * this toggle above a card telling the reader to run `pnpm tauri dev`, and its
 * six-tab strip overflowed the viewport. Tapping any tab navigated away, since
 * the section wrote `/settings` into the URL.
 *
 * Configuring the engine is deliberately not here. The access rules, the
 * permission tiers and the inspector edit or read the machine being driven, so
 * they live on that machine, and their commands never leave it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorIcon } from "lucide-react"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { HostAutomationPanel } from "@/components/mobile/automation/host-automation-panel"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"

export default function MobileComputerUsePage() {
  const t = useTranslations("mobile.me")
  const tCu = useTranslations("mobile.me.computerUse")

  const enabled = useSettingsStore((s) => s.settings?.mobileComputerUseEnabled ?? false)
  const update = useSettingsPatch()
  // Persisting the flag is an async round-trip through the settings store and
  // the outbound RPC, so surface it. A slow write should not look like a dead
  // toggle.
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
            <div className="min-w-0 text-xs text-muted-foreground">
              {enabled ? tCu("masterStateOn") : tCu("masterStateOff")}
            </div>
            <div className="flex shrink-0 items-center gap-2">
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

        <HostAutomationPanel />
      </div>
    </SubPageShell>
  )
}
