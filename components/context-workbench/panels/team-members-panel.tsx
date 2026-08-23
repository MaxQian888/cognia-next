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
import { AtSignIcon, ChevronDownIcon, ChevronRightIcon, CrownIcon, UsersIcon } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { useClientLiveQuery } from "@/hooks/data"
import { characterChatTitle } from "@/lib/chat/character-chat-title"
import { requestComposerMention } from "@/lib/chat/composer-mention-request"
import { listCharactersByIds } from "@/lib/db/characters"
import { getSession, updateSession } from "@/lib/db/sessions"
import { getTeam } from "@/lib/db/teams"
import { openCharacterChat } from "@/lib/shell/start-guild-conversation"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useUIStore, type MemberStatus } from "@/stores/ui"
import { loggers } from "@cognia/logging"
import type { Character, Team, TeamMember } from "@cognia/agent-config-types"

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

function MemberRow({
  teamSessionId,
  slot,
  character,
  supervisor,
  status,
  onNavigated,
}: {
  teamSessionId: string
  slot: TeamMember
  character: Character
  supervisor: boolean
  status: MemberStatus
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
      </ContextMenuContent>
    </ContextMenu>
  )
}
