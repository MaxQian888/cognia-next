// Achievements tab: every achievement — static catalog AND plugin
// contributions (which are evaluated/persisted by `checkAchievements` and
// would otherwise unlock invisibly) — with a locked/unlocked state. Unlocked
// set is read reactively from Dexie. Plugin achievements carry plain
// per-locale labels instead of host i18n keys. A header counts what is
// unlocked out of the whole set, and the list waits for its query instead of
// greying out every achievement while the unlocked set loads.

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
import { CountPill } from "@/components/shared/count-pill"
import { Progress } from "@/components/ui/progress"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { listPetAchievements } from "@/lib/db/pet"
import { PET_ACHIEVEMENTS } from "@/lib/pet/achievements/registry"
import { listCompiledPluginAchievements } from "@/lib/plugin/registries/pet-achievement-registry"
import { isPluginPetId, pluginAchievementText } from "@/lib/pet/plugin-display"
import { PetTabSkeleton } from "./pet-console-skeleton"

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

  if (unlocked === undefined) {
    return <PetTabSkeleton testId="pet-achievements-loading" count={8} className="max-w-none" />
  }

  const all = [...PET_ACHIEVEMENTS, ...listCompiledPluginAchievements()]
  const allIds = new Set(all.map((a) => a.id))
  // Count against the catalog, not the raw rows: an unlock recorded by a
  // plugin that is now disabled has no row on screen to count.
  const unlockedIds = new Set(unlocked.map((a) => a.id).filter((id) => allIds.has(id)))
  const total = all.length
  const summary = t("achievementsProgress.summary", { unlocked: unlockedIds.size, total })

  return (
    <div data-testid="pet-achievements-tab" className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("achievementsProgress.title")}</h2>
          <CountPill count={unlockedIds.size} tone="soft" decorative />
          <span
            data-testid="pet-achievements-progress"
            className="ml-auto text-xs text-muted-foreground tabular-nums"
          >
            {summary}
          </span>
        </div>
        <Progress
          value={total > 0 ? Math.round((unlockedIds.size / total) * 100) : 0}
          className="h-1.5"
          aria-label={summary}
        />
      </header>
      <ItemGroup data-testid="pet-achievements" className="grid gap-1 @md/pet-pane:grid-cols-2">
        {all.map((a) => {
          const Icon = ICONS[a.icon] ?? SparklesIcon
          const got = unlockedIds.has(a.id)
          const pluginText = isPluginPetId(a.id) ? pluginAchievementText(a.id, locale) : undefined
          const title = pluginText?.title ?? t(`achievements.${a.i18nKey}.title`)
          const description = pluginText
            ? pluginText.description
            : t(`achievements.${a.i18nKey}.description`)
          return (
            <Item
              key={a.id}
              data-achievement={a.id}
              data-unlocked={got}
              className={cn("min-w-0 px-0", got ? "bg-transparent" : "opacity-50 grayscale")}
            >
              <ItemMedia>
                <Icon className={cn("size-5", got ? "text-primary" : "text-muted-foreground")} />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="max-w-full truncate">{title}</ItemTitle>
                {description ? <ItemDescription>{description}</ItemDescription> : null}
              </ItemContent>
            </Item>
          )
        })}
      </ItemGroup>
    </div>
  )
}
