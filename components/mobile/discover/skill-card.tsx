"use client"

import { useState } from "react"
import { SparklesIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { setSkillStatus } from "@/lib/db/skills"
import { MobileSkillSheet } from "@/components/mobile/skills/mobile-skill-sheet"
import type { Skill } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface SkillCardProps {
  skill: Skill
  /**
   * Optional override for the toggle handler. When omitted, the card calls
   * `setSkillStatus` directly. Kept for tests + the existing discover page
   * which threads its own onToggle.
   */
  onToggle?: (skill: Skill) => void
  className?: string
}

export function SkillCard({ skill, onToggle, className }: SkillCardProps) {
  const t = useTranslations("mobile.discover")
  const tSkills = useTranslations("mobile.skills")
  const [open, setOpen] = useState(false)
  const enabled = skill.status !== "disabled"

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={tSkills("openSheet", { name: skill.name })}
        className={cn(
          "relative flex w-full items-start gap-3 rounded-md border border-border bg-card p-3 text-left",
          "active:bg-muted/50 transition-colors",
          className
        )}
        data-testid={`skill-card-${skill.id}`}
        data-enabled={enabled ? "true" : "false"}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md",
            enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          <SparklesIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 pr-12">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{skill.name}</h3>
            {skill.isBuiltIn ? (
              <Badge variant="outline" className="text-[10px]">
                {t("builtInBadge")}
              </Badge>
            ) : null}
          </div>
          {skill.description ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
          ) : null}
        </div>
        <span
          className="absolute right-2 top-2"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              if (onToggle) onToggle(skill)
              else void setSkillStatus(skill.id, v ? "enabled" : "disabled")
            }}
            aria-label={tSkills("toggleEnabled")}
          />
        </span>
      </button>
      <MobileSkillSheet skill={skill} open={open} onOpenChange={setOpen} />
    </>
  )
}
