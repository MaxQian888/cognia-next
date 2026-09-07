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
import { Loader2Icon } from "lucide-react"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { HostAutomationPanel } from "@/components/mobile/automation/host-automation-panel"
import { MeSection } from "@/components/mobile/me/me-section"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
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
      <div className="flex flex-col gap-5">
        {/* One row with the switch on it, rather than a card whose body was a
            sentence restating what the switch already showed. */}
        <MeSection title={tCu("masterToggleTitle")}>
          <Item size="sm" className="px-3 py-2.5">
            <ItemContent className="min-w-0 flex-[1_1_12rem]">
              <ItemTitle className="text-sm">
                {enabled ? tCu("masterStateOn") : tCu("masterStateOff")}
              </ItemTitle>
              {/* `line-clamp-none`: the primitive clamps to two lines, which cut
                  this sentence at "regardless of pe..." and hid the exception
                  the setting exists to explain. */}
              <ItemDescription className="line-clamp-none text-xs">
                {tCu("masterToggleDescription")}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="ml-auto gap-2">
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
            </ItemActions>
          </Item>
        </MeSection>

        <HostAutomationPanel />
      </div>
    </SubPageShell>
  )
}
