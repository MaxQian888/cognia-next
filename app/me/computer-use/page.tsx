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

import { useTranslations } from "next-intl"
import { MonitorIcon } from "lucide-react"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { AutomationSection } from "@/components/settings/automation/automation-section"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

export default function MobileComputerUsePage() {
  const t = useTranslations("mobile.me")
  const tCu = useTranslations("mobile.me.computerUse")
  const tPanel = useTranslations("mobile.settingsPanel")

  const enabled = useSettingsStore((s) => s.settings?.mobileComputerUseEnabled ?? false)
  const save = useSettingsStore((s) => s.save)

  const toggle = async (next: boolean) => {
    const patch: Partial<AppSettings> = { mobileComputerUseEnabled: next }
    await save(patch as never)
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: tPanel("queueLabel", { keys: "mobileComputerUseEnabled" }),
    })
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
            <Switch
              checked={enabled}
              onCheckedChange={(v) => void toggle(v)}
              aria-label={tCu("masterToggleAria")}
              data-testid="computer-use-master-switch"
            />
          </CardContent>
        </Card>
        <AutomationSection />
      </div>
    </SubPageShell>
  )
}
