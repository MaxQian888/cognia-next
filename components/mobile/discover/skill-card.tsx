"use client"

import { useState } from "react"
import { SparklesIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
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
          "flex w-full items-start gap-3 rounded-md border border-border bg-card p-3 text-left",
          "active:bg-muted/50 transition-colors",
          className
        )}
        data-testid={`skill-card-${skill.id}`}
        data-enabled={enabled ? "true" : "false"}
      >
        <ItemMedia
          variant="icon"
          className={cn(enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}
        >
          <SparklesIcon className="size-5" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="flex items-center gap-2">
            <span className="truncate">{skill.name}</span>
            {skill.isBuiltIn ? (
              <Badge variant="outline" className="text-[10px]">
                {t("builtInBadge")}
              </Badge>
            ) : null}
          </ItemTitle>
          {skill.description ? (
            <ItemDescription className="line-clamp-2">{skill.description}</ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions
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
        </ItemActions>
      </button>
      <MobileSkillSheet skill={skill} open={open} onOpenChange={setOpen} />
    </>
  )
}
