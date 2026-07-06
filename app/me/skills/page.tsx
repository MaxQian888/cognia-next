"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { SkillsSection } from "@/components/settings/sections/skills-section"

export default function MobileSkillsPage() {
  const t = useTranslations("mobile.me")
  // `SkillsSection` is a fill-height panel tuned for the desktop settings shell
  // (`h-[calc(100dvh-…)]` + negative margins that cancel the shell's padding).
  // Under `SubPageShell` we drop the body padding and give the section a fixed
  // viewport height, then neutralize the component's negative margins + height
  // via `className` (tailwind-merge lets these override the baked-in classes).
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
