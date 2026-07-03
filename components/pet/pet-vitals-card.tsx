// The pet's "vitals" card: level/XP progress and the three need meters in one
// bordered card. Shared by the compact interaction panel (widget/popup) and
// the wide /pet nurture tab so both surfaces render progression identically
// (and the compact panel stays short enough for the popup window).

"use client"

import { useTranslations } from "next-intl"
import { HeartPulseIcon, SmileIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { levelProgress } from "@/lib/pet/xp/leveling"
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
}

export function PetVitalsCard({ xp, needs, mood, condition, className }: PetVitalsCardProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(xp)

  return (
    <div
      data-testid="pet-vitals-card"
      className={cn("flex flex-col gap-2 rounded-lg border p-3", className)}
    >
      {(mood || condition === "unwell") && (
        <div className="flex flex-wrap items-center gap-1.5">
          {mood && (
            <span
              data-testid="pet-mood-chip"
              data-mood={mood}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium"
            >
              <SmileIcon className="size-3" />
              {t(`mood.${mood}`)}
            </span>
          )}
          {condition === "unwell" && (
            <span
              data-testid="pet-condition-chip"
              className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
            >
              <HeartPulseIcon className="size-3" />
              {t("condition.unwell")}
            </span>
          )}
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">{t("panel.level", { level: progress.level })}</span>
          <span className="text-muted-foreground tabular-nums">
            {progress.intoLevel}/{progress.span}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.round(progress.fraction * 100)}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t pt-2">
        <NeedBar kind="energy" value={needs.energy} label={t("needs.energy")} />
        <NeedBar kind="mood" value={needs.mood} label={t("needs.mood")} />
        <NeedBar kind="bond" value={needs.bond} label={t("needs.bond")} />
      </div>
    </div>
  )
}
