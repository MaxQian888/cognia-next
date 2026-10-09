"use client"

/**
 * Configure tab of the Goals console (ADR-0019): defaults for new goals, goal
 * templates, the built-in Goal Tracker agent, and the console's own
 * preferences.
 *
 * These were three tabs sitting beside Overview / History / Analytics plus a
 * gear popover in the header — configuration spread across four places and
 * mixed in with the views of goals. They are one tab now, laid out the way
 * every other settings surface in the app is: the shared master/detail frame
 * (`SettingsMasterDetail`, nav rail → drawer as the pane narrows) with one
 * panel at a time. `?tab=config&section=…` (and the old `?tab=templates` /
 * `defaults` / `tracker` links) open the right panel.
 */

import { useTranslations } from "next-intl"
import { BotIcon, LayoutTemplateIcon, SlidersHorizontalIcon, SettingsIcon } from "lucide-react"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsStack } from "@/components/settings/common/settings-block"
import {
  SETTINGS_DETAIL_PANE_CLASS,
  SettingsMasterDetail,
} from "@/components/settings/common/settings-master-detail"
import {
  SettingsPanelNav,
  type SettingsNavGroup,
} from "@/components/settings/common/settings-panel-nav"
import { GoalDefaultsForm } from "@/components/settings/goals/goal-defaults-form"
import { GoalTemplatesManager } from "@/components/settings/goals/goal-templates-manager"
import { GoalTrackerConfig } from "@/components/settings/goals/goal-tracker-config"
import type { GoalConfigSection as GoalConfigSectionId } from "@/lib/goal/console-prefs"

import { GoalConsolePrefsForm } from "./goal-console-prefs-form"

const NAV_GROUPS: readonly SettingsNavGroup<GoalConfigSectionId, "goals" | "console">[] = [
  {
    id: "goals",
    items: [
      { id: "defaults", icon: SlidersHorizontalIcon },
      { id: "templates", icon: LayoutTemplateIcon },
      { id: "tracker", icon: BotIcon },
    ],
  },
  { id: "console", items: [{ id: "console", icon: SettingsIcon }] },
]

export interface GoalConfigSectionProps {
  section: GoalConfigSectionId
  onSectionChange: (section: GoalConfigSectionId) => void
}

export function GoalConfigSection({ section, onSectionChange }: GoalConfigSectionProps) {
  const t = useTranslations("goal.configure")

  const renderNav = (idPrefix: string) => (
    <SettingsPanelNav
      groups={NAV_GROUPS}
      activeId={section}
      onSelect={onSectionChange}
      labels={{
        title: t("navTitle"),
        group: (group) => t(`groups.${group}`),
        item: (id) => ({
          label: t(`sections.${id}.label`),
          description: t(`sections.${id}.description`),
        }),
      }}
      idPrefix={idPrefix}
    />
  )

  const body = (() => {
    switch (section) {
      case "defaults":
        return <GoalDefaultsForm />
      case "templates":
        return <GoalTemplatesManager />
      case "tracker":
        return <GoalTrackerConfig />
      case "console":
        return (
          <SettingsStack>
            <GoalConsolePrefsForm />
          </SettingsStack>
        )
    }
  })()

  return (
    <SettingsMasterDetail
      nav={(slot) => renderNav(slot === "rail" ? "goal-config" : "goal-config-sheet")}
      navTitle={t("navTitle")}
      mobileTriggerLabel={t("mobileTrigger")}
      activeKey={section}
      activeLabel={t(`sections.${section}.label`)}
      navWidth={240}
      triggerTestId="goal-config-nav-trigger"
      className="h-full"
      data-testid="goal-config-section"
    >
      <div className={SETTINGS_DETAIL_PANE_CLASS}>
        <section
          aria-labelledby={`goal-config-${section}-title`}
          className="min-h-0 flex-1 overflow-y-auto px-5 pt-4"
          data-testid={`goal-config-panel-${section}`}
        >
          <div className="mb-4 space-y-0.5">
            <h2
              id={`goal-config-${section}-title`}
              className="text-base font-semibold tracking-tight"
            >
              {t(`sections.${section}.label`)}
            </h2>
            <p className="text-xs text-muted-foreground">{t(`sections.${section}.description`)}</p>
          </div>
          <PanelTransition activeKey={section} className="max-w-3xl pb-4">
            {body}
          </PanelTransition>
        </section>
      </div>
    </SettingsMasterDetail>
  )
}

GoalConfigSection.displayName = "GoalConfigSection"
