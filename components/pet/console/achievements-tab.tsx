// Achievements tab: every achievement — static catalog AND plugin
// contributions (which are evaluated/persisted by `checkAchievements` and
// would otherwise unlock invisibly) — with a locked/unlocked state. Unlocked
// set is read reactively from Dexie. Plugin achievements carry plain
// per-locale labels instead of host i18n keys.

"use client"

import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BugIcon,
  CakeIcon,
  CalendarHeartIcon,
  CandyIcon,
  CoinsIcon,
  CookieIcon,
  CrownIcon,
  DropletsIcon,
  EggIcon,
  FlameIcon,
  Gamepad2Icon,
  GemIcon,
  HandHeartIcon,
  HeartIcon,
  HeartPulseIcon,
  HourglassIcon,
  MessageCircleIcon,
  ShapesIcon,
  SparkleIcon,
  SparklesIcon,
  SproutIcon,
  StarsIcon,
  TargetIcon,
  TreePineIcon,
  TrophyIcon,
  UsersIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { listPetAchievements } from "@/lib/db/pet"
import { PET_ACHIEVEMENTS } from "@/lib/pet/achievements/registry"
import { listCompiledPluginAchievements } from "@/lib/plugin/registries/pet-achievement-registry"
import { isPluginPetId, pluginAchievementText } from "@/lib/pet/plugin-display"

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
  Trophy: TrophyIcon,
  MessageCircle: MessageCircleIcon,
  Droplets: DropletsIcon,
  Candy: CandyIcon,
  Coins: CoinsIcon,
  Shapes: ShapesIcon,
  Workflow: WorkflowIcon,
  Users: UsersIcon,
  Cake: CakeIcon,
  Sparkle: SparkleIcon,
}

export function AchievementsTab() {
  const t = useTranslations("pet")
  const locale = useLocale()
  const unlocked = useLiveQuery(() => listPetAchievements(), [])
  const unlockedIds = new Set((unlocked ?? []).map((a) => a.id))
  const all = [...PET_ACHIEVEMENTS, ...listCompiledPluginAchievements()]

  return (
    <div data-testid="pet-achievements" className="grid gap-2 @md/pet-pane:grid-cols-2">
      {all.map((a) => {
        const Icon = ICONS[a.icon] ?? SparklesIcon
        const got = unlockedIds.has(a.id)
        const pluginText = isPluginPetId(a.id) ? pluginAchievementText(a.id, locale) : undefined
        const title = pluginText?.title ?? t(`achievements.${a.i18nKey}.title`)
        const description = pluginText
          ? pluginText.description
          : t(`achievements.${a.i18nKey}.description`)
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
              <div className="truncate text-sm font-medium">{title}</div>
              {description && (
                <div className="truncate text-xs text-muted-foreground">{description}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
