"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { SkillsSection } from "@/components/settings/sections/skills-section"

export default function MobileSkillsPage() {
  const t = useTranslations("mobile.me")
  // `SkillsSection` is a fill-height panel (`flex-1 min-h-0`) that expects a
  // bounded flex parent. Under `SubPageShell` we drop the body padding and give
  // the body a fixed viewport height + flex column, then pass `m-0 h-full` so
  // the section fills that frame (the panel's own scroll stays internal).
  return (
    <SubPageShell
      title={t("skillsRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      bodyClassName="flex min-h-0 flex-col p-0 h-[calc(100dvh-3.25rem)]"
      testid="mobile-skills-page"
    >
      <SkillsSection className="m-0 h-full" />
    </SubPageShell>
  )
}
