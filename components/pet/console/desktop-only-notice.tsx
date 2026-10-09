// What a desktop-only /pet console tab shows on a paired phone or browser
// (ADR-0219): what the tab is, why it does not run here, and where to do it.
//
// The UI axis of the console's intentional dormancy (CLAUDE.md rule 7). The
// tab stays in the nav, badged "Desktop", so the reader learns the feature
// exists and where it lives; opening it lands here instead of on controls that
// would edit assets this device does not have. Which tabs are desktop-only is
// decided in `lib/pet/console/action-capabilities.ts`, never here.

"use client"

import { useTranslations } from "next-intl"
import { MonitorIcon } from "lucide-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"

/** What each desktop-only tab is for, under `pet.console.desktopOnly.what`. */
const WHAT_KEYS: Partial<Record<PetConsoleTab, string>> = {
  customize: "console.desktopOnly.what.customize",
  insights: "console.desktopOnly.what.insights",
  plugins: "console.desktopOnly.what.plugins",
}

export interface DesktopOnlyNoticeProps {
  tab: PetConsoleTab
}

export function DesktopOnlyNotice({ tab }: DesktopOnlyNoticeProps) {
  const t = useTranslations("pet")
  const label = t(`console.tabs.${tab}`)
  const what = WHAT_KEYS[tab]

  return (
    <Empty
      data-testid="pet-desktop-only-notice"
      data-tab={tab}
      className="mx-auto max-w-md border-none py-10"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t("console.desktopOnly.title", { tab: label })}</EmptyTitle>
        {what ? <EmptyDescription>{t(what)}</EmptyDescription> : null}
        <EmptyDescription>{t("console.desktopOnly.why")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-sm text-muted-foreground">
          {t("console.desktopOnly.remedy", { tab: label })}
        </p>
      </EmptyContent>
    </Empty>
  )
}
