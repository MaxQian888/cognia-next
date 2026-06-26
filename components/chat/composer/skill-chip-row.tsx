"use client"

import { useTranslations } from "next-intl"
import { SparklesIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useEffectiveSkills } from "@/hooks/skills/use-effective-skills"

interface Props {
  ids: string[]
  onRemove: (id: string) => void
  /** Skill ids switched off for this session — rendered inert (won't be sent). */
  disabledIds?: string[]
}

/**
 * Chip strip rendered above the composer input when one or more ephemeral
 * skills are attached for the next send. Each chip is removable. A chip whose
 * skill is disabled for the session renders inert with a tooltip, so the user
 * sees it won't actually be injected.
 */
export function SkillChipRow({ ids, onRemove, disabledIds }: Props) {
  const t = useTranslations("skills.composer.skillPicker")
  const { items } = useEffectiveSkills({ ephemeralSkillIds: ids, disabledIds })
  if (ids.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2">
      {items.map(({ skill: s, inert }) => (
        <Badge
          key={s.id}
          variant="outline"
          title={inert ? t("inertChip", { name: s.name }) : undefined}
          // Same soft-filled pill family as the composer's /command and
          // @mention chips: rounded-md, muted fill, soft border.
          className={cn(
            "gap-1 rounded-md border-transparent bg-primary/10 text-foreground ring-1 ring-primary/15 ring-inset",
            inert && "bg-muted text-muted-foreground line-through ring-border"
          )}
        >
          <SparklesIcon className={cn("size-3 text-primary", inert && "text-muted-foreground")} />
          <span>{s.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeChip", { name: s.name })}
            className="ml-1 size-4 rounded p-0 no-underline hover:bg-destructive/20"
            onClick={() => onRemove(s.id)}
          >
            <XIcon className="size-3" />
          </Button>
        </Badge>
      ))}
    </div>
  )
}
