"use client"

/**
 * SkillsSection — full SkillPanel embedded inside the Settings shell.
 *
 * Phase 7b of the ClaudeCode 完整化 plan: replaces the link-only
 * `SkillsLinkCard` with the same panel exposed at `/skills`. The wrapper
 * stretches the panel to a fixed viewport height so its internal scroll +
 * sidebar layout stays usable inside the Settings shell's outer ScrollArea.
 * The full-screen `/skills` route is unchanged and remains a valid alternate
 * entry.
 */

import { SkillPanel } from "@/components/skills"
import { cn } from "@/lib/utils"

interface Props {
  className?: string
}

export function SkillsSection({ className }: Props) {
  return (
    <div
      className={cn(
        "h-[calc(100dvh-var(--settings-header-h,8rem))] -mx-3 -my-3 overflow-hidden sm:-mx-4 sm:-my-4 md:-mx-5 md:-my-5 lg:-mx-6 lg:-my-6",
        className
      )}
      data-testid="skills-section"
    >
      <SkillPanel />
    </div>
  )
}

export default SkillsSection
