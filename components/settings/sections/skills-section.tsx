"use client"

/**
 * SkillsSection — full SkillPanel embedded inside the Settings shell.
 *
 * Phase 7b of the ClaudeCode 完整化 plan: replaces the link-only
 * `SkillsLinkCard` with the same panel exposed at `/skills`.
 *
 * `skills` is a member of the shell's `FILL_HEIGHT_SECTIONS`, so it renders in
 * the fixed-frame branch: a full-width (`max-w`-free), `flex-1`/`min-h-0`
 * column that already supplies bounded height and uniform padding. The wrapper
 * therefore just fills that frame (`h-full min-h-0 flex-1 flex-col`) and lets
 * SkillPanel's own master-detail layout manage the internal scroll — instead of
 * the old `100dvh - 8rem` guess (whose `--settings-header-h` var was never
 * defined) plus negative margins that fought the shell padding. Filling the
 * frame is what makes width **and** height adapt to the real pane. The
 * mobile `/me/skills` route passes `className="m-0 h-full"` and supplies its
 * own bounded flex parent, so the same fill-height wrapper works there too.
 */

import { SkillPanel } from "@/components/skills"
import { BuiltInSkillsSection } from "@/components/settings/built-in-skills"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

interface Props {
  className?: string
}

export function SkillsSection({ className }: Props) {
  const t = useTranslations("settings")

  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden", className)}
      data-testid="skills-section"
    >
      <Tabs defaultValue="installed" className="flex h-full min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b px-4 py-2">
          <TabsList>
            <TabsTrigger value="installed">{t("tabs.skills")}</TabsTrigger>
            <TabsTrigger value="built-in">{t("builtInSkills.title")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="installed" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <SkillPanel />
        </TabsContent>
        <TabsContent value="built-in" className="mt-0 min-h-0 flex-1 overflow-y-auto p-4">
          <BuiltInSkillsSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SkillsSection
