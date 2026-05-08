"use client"

import { CheckCircle2Icon, CircleIcon, SparklesIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { Skill } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface SkillCardProps {
  skill: Skill
  onToggle?: (skill: Skill) => void
  className?: string
}

export function SkillCard({ skill, onToggle, className }: SkillCardProps) {
  const t = useTranslations("mobile.discover")
  const enabled = skill.status !== "disabled"
  return (
    <button
      type="button"
      onClick={() => onToggle?.(skill)}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border border-border bg-card p-3 text-left",
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
      <div className="min-w-0 flex-1">
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
      <span aria-hidden className="ml-auto text-muted-foreground">
        {enabled ? (
          <CheckCircle2Icon className="size-5 text-emerald-500" />
        ) : (
          <CircleIcon className="size-5" />
        )}
      </span>
    </button>
  )
}
