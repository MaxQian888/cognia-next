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
import { MailIcon, PlusIcon, SettingsIcon, PencilRulerIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { AvatarBadge } from "./avatar-badge"

const log = loggers.ui

interface Props {
  onCreateTeam: () => void
  onOpenSettings: () => void
}

/**
 * The 64px-wide left rail. Mirrors Discord's top-level navigation: one button
 * for the synthetic "Direct Messages" bucket, then one button per team.
 *
 * Selection is persisted via `useUIStore.selectedGuild` so it survives
 * reloads and can be driven from the command palette.
 */
export function GuildRail({ onCreateTeam, onOpenSettings }: Props) {
  const t = useTranslations("desktop.guildRail")
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])

  const isDmActive = selected.kind === "dm"

  const switchToDm = () => {
    log.info("guild switch dm")
    setSelected({ kind: "dm" })
  }
  const switchToCanvas = () => {
    log.info("guild switch canvas")
    setSelected({ kind: "canvas" })
  }
  const switchToTeam = (teamId: string) => {
    log.info("guild switch team", { teamId })
    setSelected({ kind: "team", teamId })
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
    >
      <RailButton
        active={isDmActive}
        ariaLabel={t("directMessages")}
        tooltip={t("directMessages")}
        onClick={switchToDm}
      >
        <MailIcon className="size-5" />
      </RailButton>

      <RailButton
        active={selected.kind === "canvas"}
        ariaLabel={t("canvas")}
        tooltip={t("canvas")}
        onClick={switchToCanvas}
      >
        <PencilRulerIcon className="size-5" />
      </RailButton>

      <Separator className="my-2 w-8" />

      <ScrollArea className="w-full flex-1">
        <ul className="flex flex-col items-center gap-2 px-2">
          {(teams ?? []).map((team) => (
            <li key={team.id}>
              <TeamButton
                team={team}
                active={selected.kind === "team" && selected.teamId === team.id}
                onSelect={() => switchToTeam(team.id)}
              />
            </li>
          ))}
          <li>
            <RailButton
              ariaLabel={t("createTeam")}
              tooltip={t("createTeam")}
              onClick={handleCreateTeam}
            >
              <PlusIcon className="size-4" />
            </RailButton>
          </li>
        </ul>
      </ScrollArea>

      <Separator className="my-2 w-8" />

      <RailButton
        ariaLabel={t("openSettings")}
        tooltip={t("settings")}
        onClick={handleOpenSettings}
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
}

function RailButton({
  active,
  ariaLabel,
  tooltip,
  onClick,
  children,
  className,
  style,
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
