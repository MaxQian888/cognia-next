"use client"

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"

export interface SkillsBadgeProps {
  skills: { id: string; name: string; description?: string }[]
  /** Skill ids switched off for this session only. */
  disabled: Set<string>
  onToggle: (skillId: string, nextDisabled: boolean) => Promise<void>
}

/**
 * Per-session skills toggle, surfaced as a counter badge that opens a popover
 * of switches. Disabling a skill here is session-scoped — the character keeps
 * the skill. Extracted from `chat-header.tsx` so the slimmed header and the
 * `SessionSettingsSheet` can both mount it.
 */
export function SkillsBadge({ skills, disabled, onToggle }: SkillsBadgeProps) {
  const t = useTranslations("chat.header.skills")
  const activeCount = skills.length - disabled.size
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant={activeCount === 0 ? "outline" : "secondary"}
          className="cursor-pointer gap-1"
          aria-label={t("aria")}
        >
          <SparklesIcon className="size-3" />
          {t("counter", { active: activeCount, total: skills.length })}
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] space-y-2 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">{t("title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-col gap-2">
          {skills.map((sk) => {
            const isDisabled = disabled.has(sk.id)
            return (
              <label key={sk.id} className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{sk.name}</span>
                  {sk.description && (
                    <span className="block text-[11px] text-muted-foreground">
                      {sk.description}
                    </span>
                  )}
                </span>
                <Switch
                  checked={!isDisabled}
                  onCheckedChange={(v) => void onToggle(sk.id, !v)}
                  aria-label={t("toggleAria", { name: sk.name })}
                />
              </label>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
