"use client"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { avatarColor } from "@/lib/ui/avatar"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@/lib/logger"
import { useClientLiveQuery } from "@/hooks/data"
import { useUIStore } from "@/stores/ui"
import type { Team } from "@/lib/claude/types"
import {
  BotIcon,
  CalendarClockIcon,
  CompassIcon,
  InboxIcon,
  MailIcon,
  PencilRulerIcon,
  PlugIcon,
  PlusIcon,
  ScrollTextIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  Users2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { usePathname, useRouter } from "next/navigation"
import { AvatarBadge } from "./avatar-badge"

const log = loggers.ui

interface FeatureEntry {
  /** Top-level route under `app/`. */
  route: string
  /** i18n key under `desktop.guildRail.*`. */
  i18nKey: string
  /** Icon for the rail button. */
  Icon: LucideIcon
}

const FEATURE_ENTRIES: FeatureEntry[] = [
  { route: "/workflows", i18nKey: "workflows", Icon: WorkflowIcon },
  { route: "/inbox", i18nKey: "inbox", Icon: InboxIcon },
  { route: "/twin", i18nKey: "twin", Icon: BotIcon },
  { route: "/discover", i18nKey: "discover", Icon: CompassIcon },
  { route: "/skills", i18nKey: "skills", Icon: SparklesIcon },
  { route: "/plugins", i18nKey: "plugins", Icon: PlugIcon },
  { route: "/agent-teams", i18nKey: "agentTeams", Icon: Users2Icon },
  { route: "/scheduler", i18nKey: "scheduler", Icon: CalendarClockIcon },
]

const AUXILIARY_ENTRIES: FeatureEntry[] = [
  { route: "/logs", i18nKey: "logs", Icon: ScrollTextIcon },
  { route: "/me", i18nKey: "me", Icon: UserRoundIcon },
]

interface Props {
  onCreateTeam: () => void
  onOpenSettings: () => void
}

/**
 * The 64px-wide left rail. Discord-style top-level navigation extended with
 * route-aware feature buttons.
 *
 *   ┌───── DM · Canvas ──────┐ ← chat guilds (set selected guild + go to /)
 *   ├──── Features (8) ──────┤ ← router.push to feature routes
 *   ├──── Teams (dynamic) ───┤ ← chat guilds (per-team conversation list)
 *   ├──── Aux (Logs · Me) ───┤
 *   └────── Settings ────────┘
 *
 * Active state is computed from `usePathname()` for feature buttons and
 * from `selectedGuild` for chat buttons (when on `/`).
 */
export function GuildRail({ onCreateTeam, onOpenSettings }: Props) {
  const t = useTranslations("desktop.guildRail")
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])

  const onHomeRoute = pathname === "/"
  const isDmActive = onHomeRoute && selected.kind === "dm"
  const isCanvasActive = onHomeRoute && selected.kind === "canvas"

  const isFeatureActive = (route: string) => pathname === route || pathname.startsWith(route + "/")

  const switchToDm = () => {
    log.info("guild switch dm")
    setSelected({ kind: "dm" })
    if (!onHomeRoute) router.push("/")
  }
  const switchToCanvas = () => {
    log.info("guild switch canvas")
    setSelected({ kind: "canvas" })
    if (!onHomeRoute) router.push("/")
  }
  const switchToTeam = (teamId: string) => {
    log.info("guild switch team", { teamId })
    setSelected({ kind: "team", teamId })
    if (!onHomeRoute) router.push("/")
  }
  const goToFeature = (route: string) => {
    log.info("guild navigate feature", { route })
    router.push(route)
  }
  const handleCreateTeam = () => {
    log.info("guild create team click")
    onCreateTeam()
  }
  const handleOpenSettings = () => {
    log.info("guild open settings")
    onOpenSettings()
  }

  return (
    <aside
      className="hidden h-full w-16 shrink-0 flex-col items-center border-r bg-muted/40 py-2 md:flex"
      aria-label={t("label")}
      data-bg-target="sidebar"
    >
      <ScrollArea className="w-full flex-1">
        <div className="flex flex-col items-center gap-2 px-2">
          <RailButton
            active={isDmActive}
            ariaLabel={t("directMessages")}
            tooltip={t("directMessages")}
            onClick={switchToDm}
          >
            <MailIcon className="size-5" />
          </RailButton>

          <RailButton
            active={isCanvasActive}
            ariaLabel={t("canvas")}
            tooltip={t("canvas")}
            onClick={switchToCanvas}
          >
            <PencilRulerIcon className="size-5" />
          </RailButton>

          <Separator className="my-1 w-8" aria-label={t("featuresGroup")} />

          {FEATURE_ENTRIES.map(({ route, i18nKey, Icon }) => (
            <RailButton
              key={route}
              active={isFeatureActive(route)}
              ariaLabel={t(i18nKey)}
              tooltip={t(i18nKey)}
              onClick={() => goToFeature(route)}
              testId={`guild-feature-${i18nKey}`}
            >
              <Icon className="size-5" />
            </RailButton>
          ))}

          <Separator className="my-1 w-8" />

          <ul className="flex flex-col items-center gap-2">
            {(teams ?? []).map((team) => (
              <li key={team.id}>
                <TeamButton
                  team={team}
                  active={onHomeRoute && selected.kind === "team" && selected.teamId === team.id}
                  onSelect={() => switchToTeam(team.id)}
                />
              </li>
            ))}
            <li>
              <RailButton
                ariaLabel={t("createTeam")}
                tooltip={t("createTeam")}
                onClick={handleCreateTeam}
                testId="guild-create-team"
              >
                <PlusIcon className="size-4" />
              </RailButton>
            </li>
          </ul>

          <Separator className="my-1 w-8" aria-label={t("auxiliaryGroup")} />

          {AUXILIARY_ENTRIES.map(({ route, i18nKey, Icon }) => (
            <RailButton
              key={route}
              active={isFeatureActive(route)}
              ariaLabel={t(i18nKey)}
              tooltip={t(i18nKey)}
              onClick={() => goToFeature(route)}
              testId={`guild-feature-${i18nKey}`}
            >
              <Icon className="size-5" />
            </RailButton>
          ))}
        </div>
      </ScrollArea>

      <Separator className="my-2 w-8" />

      <RailButton
        active={pathname === "/settings" || pathname.startsWith("/settings/")}
        ariaLabel={t("openSettings")}
        tooltip={t("settings")}
        onClick={handleOpenSettings}
        testId="guild-open-settings"
      >
        <SettingsIcon className="size-4" />
      </RailButton>
    </aside>
  )
}

interface RailButtonProps {
  active?: boolean
  ariaLabel: string
  tooltip: string
  onClick: () => void
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  testId?: string
}

function RailButton({
  active,
  ariaLabel,
  tooltip,
  onClick,
  children,
  className,
  style,
  testId,
}: RailButtonProps) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          style={style}
          data-testid={testId}
          className={cn(
            "size-10 rounded-2xl transition-all hover:rounded-xl",
            active && "rounded-xl bg-primary/10 text-foreground",
            !active && "text-muted-foreground hover:text-foreground",
            className
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function TeamButton({
  team,
  active,
  onSelect,
}: {
  team: Team
  active: boolean
  onSelect: () => void
}) {
  return (
    <RailButton
      active={active}
      ariaLabel={team.name}
      tooltip={team.name}
      onClick={onSelect}
      className="text-base"
      style={active ? { boxShadow: `inset 0 0 0 2px ${avatarColor(team)}` } : undefined}
    >
      <AvatarBadge subject={team} size={28} textClassName="text-sm" />
    </RailButton>
  )
}
