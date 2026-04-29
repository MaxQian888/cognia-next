"use client"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph } from "@/lib/avatar"
import { listTeams } from "@/lib/db/teams"
import { useUIStore, type SelectedGuild } from "@/stores/ui-store"
import type { Team } from "@/lib/claude/types"
import { useLiveQuery } from "dexie-react-hooks"
import { MailIcon, PlusIcon, SettingsIcon } from "lucide-react"

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
  const selected = useUIStore((s) => s.selectedGuild)
  const setSelected = useUIStore((s) => s.setSelectedGuild)
  const teams = useLiveQuery<Team[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listTeams()),
    []
  )

  const isDmActive = selected.kind === "dm"

  return (
    <aside
      className="hidden h-full w-16 shrink-0 flex-col items-center border-r bg-muted/40 py-2 md:flex"
      aria-label="Guild rail"
    >
      <RailButton
        active={isDmActive}
        ariaLabel="Direct Messages"
        tooltip="Direct Messages"
        onClick={() => setSelected({ kind: "dm" })}
      >
        <MailIcon className="size-5" />
      </RailButton>

      <Separator className="my-2 w-8" />

      <ScrollArea className="w-full flex-1">
        <ul className="flex flex-col items-center gap-2 px-2">
          {(teams ?? []).map((team) => (
            <li key={team.id}>
              <TeamButton
                team={team}
                active={selected.kind === "team" && selected.teamId === team.id}
                onSelect={() => setSelected({ kind: "team", teamId: team.id })}
              />
            </li>
          ))}
          <li>
            <RailButton ariaLabel="Create team" tooltip="Create team" onClick={onCreateTeam}>
              <PlusIcon className="size-4" />
            </RailButton>
          </li>
        </ul>
      </ScrollArea>

      <Separator className="my-2 w-8" />

      <RailButton ariaLabel="Open settings" tooltip="Settings" onClick={onOpenSettings}>
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
      <span
        className="flex size-7 items-center justify-center rounded-full text-sm"
        style={{
          backgroundColor: avatarColor(team),
          color: "white",
        }}
        aria-hidden
      >
        {avatarGlyph(team)}
      </span>
    </RailButton>
  )
}

/**
 * Helper used by `app/page.tsx` and other code that needs to derive a guild
 * filter from a session, e.g. to switch the rail when a session is opened
 * from the command palette.
 */
export function guildForSession(session: { kind?: string; teamId?: string }): SelectedGuild {
  if (session.kind === "team" && session.teamId) {
    return { kind: "team", teamId: session.teamId }
  }
  return { kind: "dm" }
}
