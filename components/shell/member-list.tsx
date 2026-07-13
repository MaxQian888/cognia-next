"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { listCharactersByIds } from "@/lib/db/characters"
import { getSession, updateSession } from "@/lib/db/sessions"
import { getTeam } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { avatarColor } from "@/lib/ui/avatar"
import { useClientLiveQuery } from "@/hooks/data"
import { useUIStore, type MemberStatus } from "@/stores/ui"
import type { Character, Team } from "@cognia/agent-config-types"
import { ChevronDownIcon, ChevronRightIcon, StickyNoteIcon, UsersIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useRef, useState } from "react"
import { AvatarBadge } from "@/components/desktop/avatar-badge"

const log = loggers.ui

interface Props {
  /** Currently active team session id; member list is hidden if null. */
  teamSessionId: string | null
  teamId: string | null
  /**
   * Click handler for "@mention" — caller injects `@CharacterName ` into the
   * composer for the active session.
   */
  onMention: (character: Character) => void
}

/**
 * Right rail (220px). Visible only in team sessions. Shows each team member's
 * avatar, name, and live status dot. Clicking a row inserts the character's
 * `@mention` into the composer.
 */
export function MemberList({ teamSessionId, teamId, onMention }: Props) {
  const t = useTranslations("desktop.memberList")
  const showMemberList = useUIStore((s) => s.showMemberList)
  const setShowMemberList = useUIStore((s) => s.setShowMemberList)
  const memberStatus = useUIStore((s) => s.memberStatus)

  const team = useClientLiveQuery<Team | undefined>(
    () => (teamId ? getTeam(teamId) : Promise.resolve(undefined)),
    [teamId],
    undefined
  )

  const memberIdsKey = team?.members.map((m) => m.characterId).join(",") ?? ""
  const members = useClientLiveQuery<Character[]>(
    () =>
      team ? listCharactersByIds(team.members.map((m) => m.characterId)) : Promise.resolve([]),
    [team?.id, memberIdsKey],
    []
  )

  const orderedMembers = useMemo(() => {
    if (!team || !members) return []
    const byId = new Map(members.map((c) => [c.id, c]))
    return team.members
      .map((m) => byId.get(m.characterId))
      .filter((c): c is Character => Boolean(c))
  }, [team, members])

  const handleShow = () => {
    log.info("member-list show")
    setShowMemberList(true)
  }
  const handleHide = () => {
    log.info("member-list hide")
    setShowMemberList(false)
  }

  if (!teamId || !teamSessionId) return null

  if (!showMemberList) {
    return (
      // `data-bg-target="chat"` opts this rail into the wallpaper layer so it
      // matches the ChannelList on the opposite side — without it the right
      // rail stays opaque while the rest of the chat scope shows the active
      // background (see app/globals.css "Appearance: wallpaper layer").
      <div className="hidden border-l bg-muted/20 lg:flex" data-bg-target="chat">
        <Button
          variant="ghost"
          size="icon"
          className="m-2 size-8"
          onClick={handleShow}
          aria-label={t("show")}
          title={t("show")}
        >
          <UsersIcon className="size-4" />
        </Button>
      </div>
    )
  }

  return (
    <aside
      className="hidden h-full w-56 shrink-0 flex-col border-l bg-muted/20 lg:flex"
      aria-label={t("label")}
      // Mirror the ChannelList rail: absorb the chat-scope wallpaper so the
      // background and theme stay unified across both side rails. The shared
      // form-control rules then make the scratchpad textarea wallpaper-aware.
      data-bg-target="chat"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("heading", { count: orderedMembers.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleHide}
          aria-label={t("hide")}
          title={t("hide")}
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>

      <ScratchpadPanel teamSessionId={teamSessionId} />

      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 px-2 pb-2">
          {orderedMembers.map((member) => (
            <MemberRow
              key={member.id}
              teamSessionId={teamSessionId}
              character={member}
              status={memberStatus[`${teamSessionId}::${member.id}`] ?? "idle"}
              onMention={() => {
                log.info("member-list mention", {
                  teamSessionId,
                  characterId: member.id,
                })
                onMention(member)
              }}
            />
          ))}
          {orderedMembers.length === 0 && (
            <li className="px-2 py-3 text-xs text-muted-foreground">{t("empty")}</li>
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}

function ScratchpadPanel({ teamSessionId }: { teamSessionId: string }) {
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
    <div className="border-y bg-muted/10">
      <button
        type="button"
        onClick={() => setCollapsed(teamSessionId, !collapsed)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3" />
        ) : (
          <ChevronDownIcon className="size-3" />
        )}
        <StickyNoteIcon className="size-3" />
        {t("sharedNotes")}
        <span className="ml-auto font-normal normal-case text-muted-foreground">
          {draft.length > 0 ? t("charsCount", { count: draft.length }) : ""}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder={t("notesPlaceholder")}
            className="text-xs"
          />
        </div>
      )}
    </div>
  )
}

function MemberRow({
  teamSessionId,
  character,
  status,
  onMention,
}: {
  teamSessionId: string
  character: Character
  status: MemberStatus
  onMention: () => void
}) {
  const t = useTranslations("desktop.memberList")
  const requestStop = useUIStore((s) => s.requestStopMember)

  const handleStop = () => {
    log.info("member-list stop request", { teamSessionId, characterId: character.id })
    requestStop(teamSessionId, character.id)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="rounded-md hover:bg-accent">
          <button
            type="button"
            onClick={onMention}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm"
            title={t("mentionTitle", { name: character.name })}
          >
            <AvatarBadge
              subject={character}
              size={24}
              textClassName="text-xs"
              statusDot={
                <span
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
                    status === "thinking" && "animate-pulse bg-amber-500",
                    status === "errored" && "bg-destructive",
                    status === "idle" && "bg-emerald-500"
                  )}
                  aria-label={t("statusLabel", { status })}
                />
              }
            />
            <span className="min-w-0 flex-1 truncate" style={{ color: avatarColor(character) }}>
              {character.name}
            </span>
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={status !== "thinking"} onSelect={handleStop}>
          {t("stopMember")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
