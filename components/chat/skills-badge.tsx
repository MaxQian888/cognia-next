"use client"

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { resolveEffectiveSkills } from "@/lib/db/skills"

type SkillRef = { id: string; name: string; description?: string }

export interface SkillsBadgeProps {
  skills: SkillRef[]
  /** Skill ids switched off for this session only. */
  disabled: Set<string>
  onToggle: (skillId: string, nextDisabled: boolean) => Promise<void>
  /**
   * Skills attached to the NEXT message only (ad-hoc, per-message). Shown as a
   * read-only section and folded into the counter so it reflects what the next
   * send will actually inject. Excludes ids already provided by the character.
   */
  ephemeralSkills?: SkillRef[]
}

/**
 * Per-session skills toggle, surfaced as a counter badge that opens a popover
 * of switches. Disabling a skill here is session-scoped — the character keeps
 * the skill. The counter reflects the NET effective set the next send injects
 * (character ∪ ephemeral − session-disabled), via the shared
 * `resolveEffectiveSkills` precedence so it never drifts from `build-options`.
 * Extracted from `chat-header.tsx` so the slimmed header and the
 * `SessionSettingsSheet` can both mount it.
 */
export function SkillsBadge({
  skills,
  disabled,
  onToggle,
  ephemeralSkills = [],
}: SkillsBadgeProps) {
  const t = useTranslations("chat.header.skills")
  const refs = resolveEffectiveSkills({
    characterSkillIds: skills.map((s) => s.id),
    ephemeralSkillIds: ephemeralSkills.map((s) => s.id),
    disabledIds: disabled,
  })
  const activeCount = refs.filter((r) => !r.inert).length
  const totalCount = refs.length
  // Only ephemeral attachments the character doesn't already carry — the rest
  // already appear in the toggle list below.
  const characterIds = new Set(skills.map((s) => s.id))
  const attached = ephemeralSkills.filter((s) => !characterIds.has(s.id))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant={activeCount === 0 ? "outline" : "secondary"}
          className="cursor-pointer gap-1"
          aria-label={t("aria")}
        >
          <SparklesIcon className="size-3" />
          {t("counter", { active: activeCount, total: totalCount })}
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
        {attached.length > 0 && (
          <div className="space-y-1 border-t pt-2">
            <p className="text-[11px] font-semibold text-muted-foreground">{t("attachedTitle")}</p>
            <div className="flex flex-col gap-1">
              {attached.map((sk) => {
                const isInert = disabled.has(sk.id)
                return (
                  <div key={sk.id} className="flex items-center gap-1.5 text-xs">
                    <SparklesIcon className="size-3 shrink-0 text-primary" />
                    <span className={cn("min-w-0 flex-1 truncate", isInert && "line-through")}>
                      {sk.name}
                    </span>
                    {isInert && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t("attachedInert")}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
