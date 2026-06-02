// The pet's "stat card": a live preview + its deterministic identity (rarity,
// stars, shiny, the five flavour stats) and — once hatched — its name. Purely
// presentational; data comes from bones (recomputed) + the persisted soul.

"use client"

import { useTranslations } from "next-intl"
import { StarIcon, SparklesIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PetBones, PetSoul, PetStage, PetStats } from "@/types/pet"
import { PetRenderer } from "./pet-renderer"

const STAT_ORDER: (keyof PetStats)[] = ["debugging", "patience", "chaos", "wisdom", "snark"]

const RARITY_RING: Record<PetBones["rarity"], string> = {
  common: "ring-muted-foreground/30",
  uncommon: "ring-emerald-400/50",
  rare: "ring-sky-400/60",
  epic: "ring-violet-400/60",
  legendary: "ring-amber-400/70",
}

export interface PetStatCardProps {
  bones: PetBones
  soul: PetSoul | null
  stage: PetStage
  className?: string
}

export function PetStatCard({ bones, soul, stage, className }: PetStatCardProps) {
  const t = useTranslations("pet")

  return (
    <div
      data-testid="pet-stat-card"
      data-rarity={bones.rarity}
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground",
        className
      )}
    >
      <div className="flex items-center gap-4">
        <div className={cn("rounded-lg bg-muted/40 p-2 ring-2", RARITY_RING[bones.rarity])}>
          <PetRenderer bones={bones} stage={stage} state="idle" size={72} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-lg font-semibold">
              {soul?.name ?? t("statCard.unhatched")}
            </span>
            {bones.shiny && (
              <span
                data-testid="pet-shiny-badge"
                className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300"
              >
                <SparklesIcon className="size-3" />
                {t("statCard.shiny")}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span>{t(`rarity.${bones.rarity}`)}</span>
            <span data-testid="pet-stars" className="inline-flex">
              {Array.from({ length: bones.stars }).map((_, i) => (
                <StarIcon key={i} className="size-3.5 fill-amber-400 text-amber-400" />
              ))}
            </span>
          </div>
        </div>
      </div>

      <dl className="grid gap-2">
        {STAT_ORDER.map((key) => (
          <div
            key={key}
            data-stat={key}
            className="grid grid-cols-[5rem_1fr_2rem] items-center gap-2"
          >
            <dt className="text-xs text-muted-foreground">{t(`stat.${key}`)}</dt>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${bones.stats[key]}%` }}
              />
            </div>
            <dd className="text-right text-xs tabular-nums">{bones.stats[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
