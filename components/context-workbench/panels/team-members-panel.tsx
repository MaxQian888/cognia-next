"use client"

/**
 * Team members — the Context Workbench panel for a team conversation.
 *
 * This used to be a 224px column of its own, wedged between the chat pane and
 * whatever the workbench was showing: a third rail that appeared out of
 * nowhere the moment a team session opened, with its own collapse toggle and
 * its own persisted visibility flag. Every other session-scoped surface
 * (sources, memory, logs, agent status…) is a workbench panel; this one had no
 * reason to be the exception, and as a column it pushed the chat narrower
 * exactly when a team turn had the most to show.
 *
 * What the panel carries, top to bottom:
 *
 * - **The team.** Its avatar, name, member count and orchestration mode —
 *   which member replies, and why, is the first thing you need to read a team
 *   transcript, and it was previously only visible in team settings.
 * - **Shared notes.** The session `scratchpad`, injected into every member's
 *   transcript each turn. Collapsible, debounced-persisted, unchanged.
 * - **Room settings** (ADR-0177). Reply mode, room instructions, the memory
 *   switch and the muted members, stored on `ChatSession.roomSettings`.
 *   Instructions reach every member's prompt and the memory switch is what
 *   the memory plane reads. Reply mode and muting are stored now and honoured
 *   by the router in a later batch, and the section says so.
 * - **The members.** Each with its live status, its role in *this* team, the
 *   model it actually runs on (the member override, else the character's), and
 *   a supervisor marker when the team has a leader.
 *
 * Two actions per member, because the list answers two different questions.
 * Clicking the row **opens that member's own one-to-one conversation** the way
 * a Slack or Discord member list does (`openCharacterChat` switches to the
 * existing one, or starts it). The trailing `@` **mentions them in the
 * composer** — the panel is not inside the shell's tree, so that goes through
 * `requestComposerMention` rather than a threaded callback. Both, plus "stop
 * this member", are on the row's context menu.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AtSignIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CrownIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useClientLiveQuery } from "@/hooks/data"
import { characterChatTitle } from "@/lib/chat/character-chat-title"
import { requestComposerMention } from "@/lib/chat/composer-mention-request"
import {
  MAX_ROOM_INSTRUCTIONS_CHARS,
  ROOM_REPLY_MODES,
  resolveRoomSettings,
  roomSettingsPatch,
} from "@/lib/chat/room/settings"
import type { RoomSettings } from "@/lib/chat/room/types"
import { listCharactersByIds } from "@/lib/db/characters"
import { getSession, updateSession } from "@/lib/db/sessions"
import { getTeam } from "@/lib/db/teams"
import { openCharacterChat } from "@/lib/shell/start-guild-conversation"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useUIStore, type MemberStatus } from "@/stores/ui"
import { loggers } from "@cognia/logging"
import type { Character, ChatSession, Team, TeamMember } from "@cognia/agent-config-types"

const log = loggers.ui

/** Panel id in the session surface's catalogue (`chat-dock-panels.tsx`). */
export const TEAM_MEMBERS_PANEL_ID = "team-members"

const STATUS_DOT: Record<MemberStatus, string> = {
  idle: "bg-emerald-500",
  thinking: "animate-pulse bg-amber-500",
  errored: "bg-destructive",
}

interface Props {
  /** Active team session; the panel renders its empty state without one. */
  teamSessionId: string | null
  teamId: string | null
  /**
   * Fires after an action that navigated away from the team conversation, so a
   * host that is an overlay can dismiss itself. The workbench passes nothing —
   * it stays open across the switch, like every other panel.
   */
  onNavigated?: () => void
}

export function TeamMembersPanel({ teamSessionId, teamId, onNavigated }: Props) {
  const t = useTranslations("desktop.memberList")
  const tOrchestration = useTranslations("settings.teams.orchestration")
  const memberStatus = useUIStore((s) => s.memberStatus)

  const team = useClientLiveQuery<Team | undefined>(
    () => (teamId ? getTeam(teamId) : Promise.resolve(undefined)),
    [teamId],
    undefined
  )

  const session = useClientLiveQuery<ChatSession | undefined>(
    () => (teamSessionId ? getSession(teamSessionId) : Promise.resolve(undefined)),
    [teamSessionId],
    undefined
  )
  const roomSettings = useMemo(() => resolveRoomSettings(session), [session])

  const memberIdsKey = team?.members.map((m) => m.characterId).join(",") ?? ""
  const characters = useClientLiveQuery<Character[]>(
    () =>
      team ? listCharactersByIds(team.members.map((m) => m.characterId)) : Promise.resolve([]),
    [team?.id, memberIdsKey],
    []
  )

  /** Team slot + resolved character, in the team's own reply order. */
  const rows = useMemo(() => {
    if (!team || !characters) return []
    const byId = new Map(characters.map((c) => [c.id, c]))
    return team.members.flatMap((slot) => {
      const character = byId.get(slot.characterId)
      return character ? [{ slot, character }] : []
    })
  }, [team, characters])

  if (!teamId || !teamSessionId) {
    return (
      <Empty className="h-full rounded-none" data-testid="team-members-empty-session">
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("label")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("noTeamSession")}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col" data-testid="team-members-panel">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {team ? (
          <AvatarBadge subject={team} size={20} textClassName="text-[10px]" />
        ) : (
          <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{team?.name ?? t("label")}</p>
          {/* Which member replies, and why. Only readable in team settings until
              now, and it is the first thing a team transcript needs explained. */}
          <p className="truncate text-[11px] text-muted-foreground">
            {team ? tOrchestration(team.orchestration) : t("heading", { count: rows.length })}
          </p>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {t("heading", { count: rows.length })}
        </span>
      </div>

      <SharedNotes teamSessionId={teamSessionId} />

      <RoomSettingsSection
        teamSessionId={teamSessionId}
        session={session}
        members={rows.map((row) => row.character)}
      />

      <ScrollArea className="flex-1">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-2">
            {rows.map(({ slot, character }) => (
              <MemberRow
                key={character.id}
                teamSessionId={teamSessionId}
                slot={slot}
                character={character}
                supervisor={team?.supervisorCharacterId === character.id}
                status={memberStatus[`${teamSessionId}::${character.id}`] ?? "idle"}
                muted={roomSettings.mutedMemberIds.includes(character.id)}
                onToggleMute={() =>
                  persistRoomSettings(teamSessionId, session, {
                    mutedMemberIds: toggleId(roomSettings.mutedMemberIds, character.id),
                  })
                }
                onNavigated={onNavigated}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

/**
 * The session `scratchpad`, injected into every member's transcript each turn.
 * Collapsed state is per-session, so a team whose notes you never use stays
 * folded without hiding another team's.
 */
function SharedNotes({ teamSessionId }: { teamSessionId: string }) {
  const t = useTranslations("desktop.memberList")
  const collapsed = useUIStore((s) => s.scratchpadCollapsed[teamSessionId] ?? false)
  const setCollapsed = useUIStore((s) => s.setScratchpadCollapsed)

  const session = useClientLiveQuery(() => getSession(teamSessionId), [teamSessionId], undefined)

  const [draft, setDraft] = useState(session?.scratchpad ?? "")
  // Keep the textarea in sync when the session id changes (different team).
  // We intentionally don't sync on every Dexie update — the user is the
  // authoritative editor; reflecting remote writes would be racy.
  const lastSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastSessionRef.current === teamSessionId) return
    lastSessionRef.current = teamSessionId
    setDraft(session?.scratchpad ?? "")
  }, [teamSessionId, session?.scratchpad])

  // Debounced persist (500ms after the last keystroke).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (lastSessionRef.current !== teamSessionId) return
    const persisted = session?.scratchpad ?? ""
    if (draft === persisted) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void updateSession(teamSessionId, { scratchpad: draft }).catch((err) => {
        log.error("scratchpad persist failed", err, { teamSessionId })
      })
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, teamSessionId])

  return (
    <div className="shrink-0 border-b">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setCollapsed(teamSessionId, !collapsed)}
        aria-expanded={!collapsed}
        data-testid="team-members-notes-toggle"
        className="h-8 w-full justify-start gap-1.5 rounded-none px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{t("sharedNotes")}</span>
        <span className="ml-auto shrink-0 font-normal normal-case tabular-nums">
          {draft.length > 0 ? t("charsCount", { count: draft.length }) : ""}
        </span>
      </Button>
      {collapsed ? null : (
        <div className="px-3 pb-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={t("notesPlaceholder")}
            aria-label={t("sharedNotes")}
            className="resize-y text-xs"
          />
        </div>
      )}
    </div>
  )
}

function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id]
}

/** One write path for every control, so the memory mirror can never be skipped. */
function persistRoomSettings(
  teamSessionId: string,
  session: ChatSession | undefined,
  change: Partial<RoomSettings>
): void {
  void updateSession(teamSessionId, roomSettingsPatch(session?.roomSettings, change)).catch(
    (err) => {
      log.error("room settings persist failed", err, { teamSessionId })
    }
  )
}

/**
 * The room's own settings (ADR-0177, batch 1). Collapsed by default with a
 * one-line summary, because the members list is what the panel is for.
 *
 * Reply mode and muting are the two dormant controls: their values are stored
 * on the row today and read by the router in batch 3. They render, they
 * persist, and the note under them says they do not yet steer a turn, which
 * is the label hard rule 7 asks for.
 */
function RoomSettingsSection({
  teamSessionId,
  session,
  members,
}: {
  teamSessionId: string
  session: ChatSession | undefined
  members: readonly Character[]
}) {
  const t = useTranslations("desktop.memberList")
  const [collapsed, setCollapsed] = useState(true)
  const resolved = useMemo(() => resolveRoomSettings(session), [session])

  const [draft, setDraft] = useState(resolved.instructions)
  const lastSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastSessionRef.current === teamSessionId) return
    lastSessionRef.current = teamSessionId
    setDraft(resolved.instructions)
  }, [teamSessionId, resolved.instructions])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (lastSessionRef.current !== teamSessionId) return
    if (draft === resolved.instructions) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      persistRoomSettings(teamSessionId, session, { instructions: draft })
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, teamSessionId])

  const nameOf = (id: string) => members.find((member) => member.id === id)?.name ?? id
  const summary = t("roomSettings.summary", {
    replyMode: t(`roomSettings.replyModes.${resolved.replyMode}`),
    memory: t(resolved.memory ? "roomSettings.memoryOn" : "roomSettings.memoryOff"),
  })

  return (
    <div className="shrink-0 border-b" data-testid="room-settings">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        data-testid="room-settings-toggle"
        className="h-8 w-full justify-start gap-1.5 rounded-none px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
        <Settings2Icon className="size-3 shrink-0" />
        <span className="truncate">{t("roomSettings.title")}</span>
        <span
          className="ml-auto min-w-0 truncate font-normal normal-case tracking-normal"
          data-testid="room-settings-summary"
        >
          {summary}
        </span>
      </Button>
      {collapsed ? null : (
        <div className="flex flex-col gap-3 px-3 pb-3 text-xs">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("roomSettings.replyMode")}
            </span>
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label={t("roomSettings.replyMode")}
            >
              {ROOM_REPLY_MODES.map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={resolved.replyMode === mode ? "secondary" : "outline"}
                  aria-pressed={resolved.replyMode === mode}
                  data-inert="true"
                  data-testid={`room-reply-mode-${mode}`}
                  onClick={() => persistRoomSettings(teamSessionId, session, { replyMode: mode })}
                  className="h-7 px-2 text-xs"
                >
                  {t(`roomSettings.replyModes.${mode}`)}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground" data-testid="room-settings-inert-note">
              {t("roomSettings.inertNote")}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={`room-instructions-${teamSessionId}`}
              className="flex items-center text-[11px] font-medium text-muted-foreground"
            >
              <span className="truncate">{t("roomSettings.instructions")}</span>
              <span className="ml-auto shrink-0 font-normal tabular-nums">
                {draft.length > 0 ? t("charsCount", { count: draft.length }) : ""}
              </span>
            </label>
            <Textarea
              id={`room-instructions-${teamSessionId}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={MAX_ROOM_INSTRUCTIONS_CHARS}
              placeholder={t("roomSettings.instructionsPlaceholder")}
              data-testid="room-instructions"
              className="resize-y text-xs"
            />
          </div>

          <div className="flex items-start gap-2">
            <Switch
              id={`room-memory-${teamSessionId}`}
              checked={resolved.memory}
              onCheckedChange={(memory) => persistRoomSettings(teamSessionId, session, { memory })}
              aria-label={t("roomSettings.memory")}
              data-testid="room-memory-switch"
            />
            <label htmlFor={`room-memory-${teamSessionId}`} className="flex min-w-0 flex-col">
              <span className="text-xs font-medium">{t("roomSettings.memory")}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(resolved.memory ? "roomSettings.memoryHint" : "roomSettings.memoryOffHint")}
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-1" data-testid="room-muted-members">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("roomSettings.mutedMembers")}
            </span>
            {resolved.mutedMemberIds.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{t("roomSettings.noMuted")}</p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {resolved.mutedMemberIds.map((id) => (
                  <li key={id}>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-inert="true"
                      data-testid={`room-unmute-${id}`}
                      title={t("roomSettings.unmute", { name: nameOf(id) })}
                      aria-label={t("roomSettings.unmute", { name: nameOf(id) })}
                      onClick={() =>
                        persistRoomSettings(teamSessionId, session, {
                          mutedMemberIds: toggleId(resolved.mutedMemberIds, id),
                        })
                      }
                      className="h-6 px-2 text-[11px]"
                    >
                      {nameOf(id)}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MemberRow({
  teamSessionId,
  slot,
  character,
  supervisor,
  status,
  muted,
  onToggleMute,
  onNavigated,
}: {
  teamSessionId: string
  slot: TeamMember
  character: Character
  supervisor: boolean
  status: MemberStatus
  muted: boolean
  onToggleMute: () => void
  onNavigated?: () => void
}) {
  const t = useTranslations("desktop.memberList")
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const requestStop = useUIStore((s) => s.requestStopMember)

  // The member override is what actually runs; the character's model is the
  // fallback, and "no model" means the session default rather than "none".
  const model = slot.modelOverride ?? character.model ?? null
  const openChatLabel = t("openChat", { name: character.name })
  const mentionLabel = t("mentionTitle", { name: character.name })

  const openChat = () => {
    log.info("team-members open chat", { teamSessionId, characterId: character.id })
    void openCharacterChat(character, {
      newChatTitle: characterChatTitle(t, character.name),
      navigate: (route) => router.push(route),
      pathname,
    })
      .then(() => onNavigated?.())
      .catch((error: unknown) => {
        log.warn("team-members open chat failed", { error: String(error) })
      })
  }
  const mention = () => {
    log.info("team-members mention", { teamSessionId, characterId: character.id })
    requestComposerMention(character.name)
  }
  const stop = () => {
    log.info("team-members stop request", { teamSessionId, characterId: character.id })
    requestStop(teamSessionId, character.id)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className="flex min-w-0 items-center gap-0.5 rounded-md"
          data-testid={`team-member-${character.id}`}
        >
          <Button
            type="button"
            variant="ghost"
            onClick={openChat}
            title={openChatLabel}
            aria-label={openChatLabel}
            className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left font-normal"
          >
            <AvatarBadge
              subject={character}
              size={24}
              textClassName="text-xs"
              statusDot={
                <span
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
                    STATUS_DOT[status]
                  )}
                  aria-label={t("statusLabel", { status: t(`status.${status}`) })}
                />
              }
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-sm" style={{ color: avatarColor(character) }}>
                  {character.name}
                </span>
                {supervisor ? (
                  <CrownIcon
                    className="size-3 shrink-0 text-amber-500"
                    aria-label={t("supervisor")}
                  />
                ) : null}
                {muted ? (
                  <span
                    className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground"
                    data-inert="true"
                    data-testid={`team-member-muted-${character.id}`}
                  >
                    {t("roomSettings.muted")}
                  </span>
                ) : null}
              </span>
              {/* Role in *this* team, then the model it will actually answer
                  with — the two facts that tell members of one team apart. */}
              <span className="truncate text-[11px] text-muted-foreground">
                {[slot.role, model ?? t("defaultModel")].filter(Boolean).join(" · ")}
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={mention}
            title={mentionLabel}
            aria-label={mentionLabel}
            data-testid={`team-member-mention-${character.id}`}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <AtSignIcon className="size-3.5" />
          </Button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={`team-member-menu-${character.id}`}>
        <ContextMenuItem onSelect={openChat}>{openChatLabel}</ContextMenuItem>
        <ContextMenuItem onSelect={mention}>{mentionLabel}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={status !== "thinking"} onSelect={stop}>
          {t("stopMember")}
        </ContextMenuItem>
        <ContextMenuItem
          data-inert="true"
          data-testid={`team-member-mute-${character.id}`}
          onSelect={onToggleMute}
        >
          {muted
            ? t("roomSettings.unmute", { name: character.name })
            : t("roomSettings.mute", { name: character.name })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
