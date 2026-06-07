"use client"

/**
 * Detail surface for a `/loop`. Three tabs:
 *   - Overview  — status, prompt, iteration/budget progress, mode facts
 *   - Activity  — reverse-chrono event log from `loopEvents`
 *   - Settings  — per-loop config knobs (caps + self-paced delay bounds)
 *
 * Shell (Sheet desktop / Drawer mobile) comes from the shared
 * `ResponsiveDetailSheet`; the tab strip scrolls horizontally on narrow
 * screens, same as the goal sheet.
 */

import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import type { Loop } from "@/types/loop"
import { LoopOverviewTab } from "./tabs/overview-tab"
import { LoopActivityTab } from "./tabs/activity-tab"
import { LoopSettingsTab } from "./tabs/settings-tab"

interface Props {
  loop: Loop
  open: boolean
  onOpenChange: (next: boolean) => void
}

const TAB_TRIGGER_CLASS = "min-h-11 shrink-0 md:min-h-0"

export function LoopDetailSheet({ loop, open, onOpenChange }: Props) {
  const t = useTranslations("loop")
  const title = t("detailSheet.title", { status: t(`status.${loop.status}`) })

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={loop.safePrompt}
    >
      <Tabs defaultValue="overview" className="mt-4 flex-1 overflow-y-auto px-4 pb-4">
        <TabsList className="flex w-full justify-start overflow-x-auto md:grid md:grid-cols-3">
          <TabsTrigger
            value="overview"
            className={TAB_TRIGGER_CLASS}
            data-testid="loop-tab-overview"
          >
            {t("detailSheet.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className={TAB_TRIGGER_CLASS}
            data-testid="loop-tab-activity"
          >
            {t("detailSheet.tabs.activity")}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className={TAB_TRIGGER_CLASS}
            data-testid="loop-tab-settings"
          >
            {t("detailSheet.tabs.settings")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <LoopOverviewTab loop={loop} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <LoopActivityTab loop={loop} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <LoopSettingsTab loop={loop} />
        </TabsContent>
      </Tabs>
    </ResponsiveDetailSheet>
  )
}
