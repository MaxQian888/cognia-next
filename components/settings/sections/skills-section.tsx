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
import { cn } from "@/lib/utils"

interface Props {
  className?: string
}

export function SkillsSection({ className }: Props) {
  return (
    <div
      className={cn("flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden", className)}
      data-testid="skills-section"
    >
      <SkillPanel />
    </div>
  )
}

export default SkillsSection
