"use client"

/**
 * The manual member picker (ADR-0177, batch 3): who answers the next send.
 *
 * Two surfaces over one store (`stores/chat/room-target-store.ts`):
 *
 * - `RoomTargetPicker` is the button in the composer's capability row. It
 *   opens a list of the room's members to tick. A `manual` team has no other
 *   way to get a reply. Every other team gets a way to override its routing
 *   for a turn without typing an `@`.
 * - `RoomTargetChip` sits in the context row with the attachments and the
 *   reply target: it names the standing pick and clears it, and when there is
 *   no pick it says why the room may stay quiet (asleep, mention only, or a
 *   manual team with nobody picked), because a turn that gets no reply with
 *   no explanation reads as a bug.
 *
 * A pick beats mute and reply mode in the router, so a muted member is still
 * offered here, marked as muted. The one thing a pick does not beat is
 * `asleep`, so the picker is disabled then and says so.
 */

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, UsersIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useClientLiveQuery } from "@/hooks/data"
import { useTeamMemberRoles, useTeamMembers } from "@/hooks/use-team-members"
import { resolveRoomSettings } from "@/lib/chat/room/settings"
import type { RoomReplyMode } from "@/lib/chat/room/types"
import { getSession } from "@/lib/db/sessions"
import { getTeam } from "@/lib/db/teams"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useRoomTargetStore, useRoomTargets } from "@/stores/chat/room-target-store"
import type { ChatSession, Team, TeamOrchestration } from "@cognia/agent-config-types"
import { useComposerSessionId } from "./composer-session-context"

/** Why the next send may get no reply, or `null` when somebody will answer. */
export type RoomReplyHint = "asleep" | "mention_only" | "manual"

/**
 * The composer's mirror of `planUserTurn`'s hold reasons, minus what it
 * cannot know before the text is typed (a mention). Pure, so the chip and a
 * test read one rule.
 */
export function roomReplyHint(input: {
  orchestration: TeamOrchestration | undefined
  replyMode: RoomReplyMode
  pickedCount: number
}): RoomReplyHint | null {
  if (input.replyMode === "asleep") return "asleep"
  if (input.pickedCount > 0) return null
  if (input.replyMode === "mention_only") return "mention_only"
  if (input.orchestration === "manual") return "manual"
  return null
}

function useRoomTargetContext(session: ChatSession | null | undefined) {
  const isTeamRoom = session?.kind === "team" && Boolean(session.teamId)
  const teamId = isTeamRoom ? (session?.teamId ?? null) : null
  const team = useClientLiveQuery<Team | undefined>(
    () => (teamId ? getTeam(teamId) : Promise.resolve(undefined)),
    [teamId],
    undefined
  )
  const members = useTeamMembers(teamId)
  const roles = useTeamMemberRoles(teamId)
  const settings = useMemo(() => resolveRoomSettings(session), [session])
  const targets = useRoomTargets(session?.id)
  const hint = useMemo(
    () =>
      isTeamRoom
        ? roomReplyHint({
            orchestration: team?.orchestration,
            replyMode: settings.replyMode,
            pickedCount: targets.length,
          })
        : null,
    [isTeamRoom, team?.orchestration, settings.replyMode, targets.length]
  )
  return { isTeamRoom, team, members, roles, settings, targets, hint }
}

export interface RoomTargetPickerProps {
  session: ChatSession | null | undefined
  disabled?: boolean
}

export function RoomTargetPicker({ session, disabled = false }: RoomTargetPickerProps) {
  const t = useTranslations("chat.composer.roomTargets")
  const { isTeamRoom, members, roles, settings, targets } = useRoomTargetContext(session)
  const toggleTarget = useRoomTargetStore((state) => state.toggleTarget)
  const setTargets = useRoomTargetStore((state) => state.setTargets)
  if (!isTeamRoom || !session) return null
  const asleep = settings.replyMode === "asleep"
  const sessionId = session.id

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={targets.length > 0 ? "default" : "ghost"}
          disabled={disabled || asleep}
          aria-label={t("trigger")}
          title={asleep ? t("asleepDisabled") : t("trigger")}
          className="size-7"
          data-testid="composer-room-target-trigger"
          data-picked={targets.length > 0 ? targets.length : undefined}
        >
          <UsersIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" data-testid="composer-room-target-menu">
        <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{t("title")}</p>
        <ul className="flex flex-col gap-0.5" role="group" aria-label={t("title")}>
          {members.map((member) => {
            const picked = targets.includes(member.id)
            const muted = settings.mutedMemberIds.includes(member.id)
            const role = roles.get(member.id)
            return (
              <li key={member.id}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={picked}
                  onClick={() => toggleTarget(sessionId, member.id)}
                  data-testid={`composer-room-target-${member.id}`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
                    picked && "bg-accent/60"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                      picked ? "border-primary bg-primary text-primary-foreground" : "border-border"
                    )}
                    aria-hidden
                  >
                    {picked ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: avatarColor(member) }}>
                    {member.name}
                  </span>
                  {role ? (
                    <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                      {role}
                    </span>
                  ) : null}
                  {muted ? (
                    <span
                      className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground"
                      data-testid={`composer-room-target-muted-${member.id}`}
                    >
                      {t("muted")}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={targets.length === 0}
          onClick={() => setTargets(sessionId, [])}
          className="mt-1 h-7 w-full justify-start px-2 text-xs"
          data-testid="composer-room-target-clear"
        >
          {t("clear")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export interface RoomTargetChipProps {
  /** Render the chip alone, for a parent that owns the row layout. */
  bare?: boolean
}

export function RoomTargetChip({ bare = false }: RoomTargetChipProps = {}) {
  const t = useTranslations("chat.composer.roomTargets")
  const composerSessionId = useComposerSessionId()
  const session = useClientLiveQuery<ChatSession | undefined>(
    () => (composerSessionId ? getSession(composerSessionId) : Promise.resolve(undefined)),
    [composerSessionId],
    undefined
  )
  const { isTeamRoom, members, targets, hint } = useRoomTargetContext(session)
  const setTargets = useRoomTargetStore((state) => state.setTargets)
  if (!isTeamRoom || !session) return null

  let chip: ReactNode = null
  // Asleep outranks a pick in the router, so it outranks the pick here too.
  if (targets.length > 0 && hint !== "asleep") {
    const names = targets.map((id) => members.find((member) => member.id === id)?.name ?? id)
    chip = (
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs"
        title={names.join(", ")}
        data-testid="composer-room-target-chip"
      >
        <UsersIcon className="size-3 shrink-0 text-primary" aria-hidden />
        <span className="shrink-0 text-muted-foreground">{t("chipLabel")}</span>
        <span className="max-w-[min(280px,calc(100vw-8rem))] truncate">{names.join(", ")}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("clearChip")}
          onClick={() => setTargets(session.id, [])}
          className="size-5 opacity-60 transition-opacity hover:opacity-100"
          data-testid="composer-room-target-chip-clear"
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    )
  } else if (hint) {
    chip = (
      <p
        className="rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground"
        data-testid="composer-room-hint"
        data-hint={hint}
      >
        {t(`hint.${hint}`)}
      </p>
    )
  }
  if (!chip) return null
  if (bare) return chip
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chip}</div>
}
