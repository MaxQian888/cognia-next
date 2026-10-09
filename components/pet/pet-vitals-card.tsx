// The pet's "vitals" card: level/XP progress and the three need meters in one
// bordered card. Shared by the compact interaction panel (widget/popup) and
// the wide /pet nurture tab so both surfaces render progression identically
// (and the compact panel stays short enough for the popup window).

"use client"

import { useTranslations } from "next-intl"
import { HeartPulseIcon, SmileIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { levelProgress } from "@/lib/pet/xp/leveling"
import { WELL_RECOVERY_THRESHOLD } from "@/lib/pet/care/condition"
import type { PetCondition, PetMood } from "@/types/pet"
import { NeedBar } from "./need-bar"

export interface PetVitalsCardProps {
  /** Total XP — the level split is derived here via `levelProgress`. */
  xp: number
  needs: { energy: number; mood: number; bond: number }
  /** Derived mood — shown as a chip when given. */
  mood?: PetMood
  /** Care condition — an "unwell" badge appears when it isn't "well". */
  condition?: PetCondition
  className?: string
  variant?: "outlined" | "flat"
  /**
   * Spell out how to bring an unwell pet back, under the chips. Off in the
   * compact panel, which has to stay popup-short; there the same sentence
   * rides the chip's tooltip instead.
   */
  recoveryHint?: boolean
}

export function PetVitalsCard({
  xp,
  needs,
  mood,
  condition,
  className,
  variant = "outlined",
  recoveryHint = false,
}: PetVitalsCardProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(xp)
  // "Needs care" alone named the problem without the way out: recovery is not
  // one action, it is energy AND mood back above the hysteresis threshold.
  const hint = t("condition.recoveryHint", { threshold: WELL_RECOVERY_THRESHOLD })

  return (
    <div
      data-testid="pet-vitals-card"
      data-variant={variant}
      className={cn(
        "flex flex-col gap-2",
        variant === "outlined" && "rounded-lg border p-3",
        className
      )}
    >
      {(mood || condition === "unwell") && (
        <div className="flex flex-wrap items-center gap-1.5">
          {mood && (
            <Badge data-testid="pet-mood-chip" data-mood={mood} variant="secondary">
              <SmileIcon className="size-3" />
              {t(`mood.${mood}`)}
            </Badge>
          )}
          {condition === "unwell" && (
            <Badge data-testid="pet-condition-chip" variant="destructive" title={hint}>
              <HeartPulseIcon className="size-3" />
              {t("condition.unwell")}
            </Badge>
          )}
        </div>
      )}

      {condition === "unwell" && recoveryHint ? (
        <p data-testid="pet-condition-hint" className="text-xs text-pretty text-muted-foreground">
          {hint}
        </p>
      ) : null}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">{t("panel.level", { level: progress.level })}</span>
          <span className="text-muted-foreground tabular-nums">
            {progress.intoLevel}/{progress.span}
          </span>
        </div>
        <Progress value={Math.round(progress.fraction * 100)} className="h-1.5" />
      </div>

      <div className="flex flex-col gap-2 border-t pt-2">
        <NeedBar kind="energy" value={needs.energy} label={t("needs.energy")} />
        <NeedBar kind="mood" value={needs.mood} label={t("needs.mood")} />
        <NeedBar kind="bond" value={needs.bond} label={t("needs.bond")} />
      </div>
    </div>
  )
}
