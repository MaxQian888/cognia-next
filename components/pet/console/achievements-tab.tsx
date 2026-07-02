// Achievements tab: every achievement with a locked/unlocked state. Unlocked set
// is read reactively from Dexie.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BugIcon,
  CalendarHeartIcon,
  CookieIcon,
  CrownIcon,
  EggIcon,
  FlameIcon,
  Gamepad2Icon,
  GemIcon,
  HandHeartIcon,
  HeartIcon,
  HeartPulseIcon,
  HourglassIcon,
  SparklesIcon,
  SproutIcon,
  StarsIcon,
  TargetIcon,
  TreePineIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { listPetAchievements } from "@/lib/db/pet"
import { PET_ACHIEVEMENTS } from "@/lib/pet/achievements/registry"

const ICONS: Record<string, LucideIcon> = {
  Egg: EggIcon,
  Sparkles: SparklesIcon,
  Sprout: SproutIcon,
  TreePine: TreePineIcon,
  Crown: CrownIcon,
  Cookie: CookieIcon,
  Gamepad2: Gamepad2Icon,
  Heart: HeartIcon,
  Target: TargetIcon,
  Stars: StarsIcon,
  Gem: GemIcon,
  Bug: BugIcon,
  Hourglass: HourglassIcon,
  Zap: ZapIcon,
  HeartPulse: HeartPulseIcon,
  HandHeart: HandHeartIcon,
  Flame: FlameIcon,
  CalendarHeart: CalendarHeartIcon,
}

export function AchievementsTab() {
  const t = useTranslations("pet")
  const unlocked = useLiveQuery(() => listPetAchievements(), [])
  const unlockedIds = new Set((unlocked ?? []).map((a) => a.id))

  return (
    <div data-testid="pet-achievements" className="grid gap-2 sm:grid-cols-2">
      {PET_ACHIEVEMENTS.map((a) => {
        const Icon = ICONS[a.icon] ?? SparklesIcon
        const got = unlockedIds.has(a.id)
        return (
          <div
            key={a.id}
            data-achievement={a.id}
            data-unlocked={got}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3",
              got ? "bg-card" : "opacity-50 grayscale"
            )}
          >
            <Icon className={cn("size-5", got ? "text-primary" : "text-muted-foreground")} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {t(`achievements.${a.i18nKey}.title`)}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {t(`achievements.${a.i18nKey}.description`)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
