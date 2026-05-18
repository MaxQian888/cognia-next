"use client"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow } from "@/hooks/ui"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { getTeam } from "@/lib/db/teams"
import { loggers } from "@/lib/logger"
import { avatarColor } from "@/lib/ui/avatar"
import { useUIStore } from "@/stores/ui"
import type { Character, ChatSession, Team } from "@/lib/claude/types"
import { MailIcon, MenuIcon, PlusIcon, UsersIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { AvatarBadge } from "./avatar-badge"
import { SessionRow } from "./session-row"

const log = loggers.ui

interface Props {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
}

/**
 * The mid sidebar (~260px). Lists sessions filtered by the currently selected
 * guild from `useUIStore`. On narrow viewports it collapses to a sheet
 * triggered by a hamburger button at the very top-left.
 */
export function ChannelList(props: Props) {
  const t = useTranslations("desktop.channelList")
  const isNarrow = useIsNarrow()
  const [openMobile, setOpenMobile] = useState(false)

  const handleSelect = (id: string) => {
    props.onSelect(id)
    if (isNarrow) setOpenMobile(false)
  }

  const handleSheetChange = (next: boolean) => {
    log.info("channel-list sheet toggle", { open: next })
    setOpenMobile(next)
  }

  if (isNarrow) {
    return (
      <Sheet open={openMobile} onOpenChange={handleSheetChange}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("openSessions")}
            className="absolute top-2 left-2 z-10 md:hidden"
          >
            <MenuIcon className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="px-3 pt-3 pb-1">
            <SheetTitle className="text-sm">{t("conversationsTitle")}</SheetTitle>
          </SheetHeader>
          <ChannelListBody {...props} onSelect={handleSelect} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      className="hidden h-full w-64 shrink-0 flex-col border-r bg-background md:flex"
      aria-label={t("conversationsTitle")}
      data-bg-target="chat"
    >
      <ChannelListBody {...props} onSelect={handleSelect} />
    </aside>
  )
}

function ChannelListBody({
  sessions,
  activeSessionId,
  onSelect,
  onNewDirect,
  onNewTeamConversation,
  onDelete,
  onRename,
}: Props) {
  const t = useTranslations("desktop.channelList")
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  // Narrow once: this component is only ever rendered for the chat
  // (DM/team) guilds. The shell branches on `kind === "canvas"`
  // upstream and renders the CanvasDocumentRail instead.
  const chatGuild = useMemo(
    () => (selectedGuild.kind === "canvas" ? ({ kind: "dm" } as const) : selectedGuild),
    [selectedGuild]
  )
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of characters ?? []) map.set(c.id, c)
    return map
  }, [characters])

  const sessionStates = useClientLiveQuery(() => listSessionStates(), [], [])
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates])

  const team = useClientLiveQuery<Team | undefined>(
    () => (chatGuild.kind === "team" ? getTeam(chatGuild.teamId) : Promise.resolve(undefined)),
    [chatGuild],
    undefined
  )

  // Filter the session list by selected guild. (Phase D) Sessions with
  // `kind === "workflow-editor"` are scoped to the workflow editor's chat
  // tab and never surface in the main channel list — they appear ONLY
  // inside the editor itself.
  const filtered = useMemo(() => {
    const visible = sessions.filter((s) => s.kind !== "workflow-editor")
    if (chatGuild.kind === "team") {
      return visible.filter((s) => s.kind === "team" && s.teamId === chatGuild.teamId)
    }
    // DM bucket: anything that isn't a team session.
    return visible.filter((s) => s.kind !== "team")
  }, [sessions, chatGuild])

  // For DMs, group by character; legacy sessions land under "Other".
  const dmGroups = useMemo(() => {
    if (chatGuild.kind !== "dm") return null
    const groups = new Map<string | null, ChatSession[]>()
    for (const s of filtered) {
      const key = s.characterId ?? null
      const arr = groups.get(key) ?? []
      arr.push(s)
      groups.set(key, arr)
    }
    return groups
  }, [filtered, chatGuild])

  const handleNewDirect = () => {
    log.info("channel-list new-direct")
    onNewDirect()
  }
  const handleNewTeamConversation = (teamId: string) => {
    log.info("channel-list new-team-conversation", { teamId })
    onNewTeamConversation(teamId)
  }

  // Canvas guild has its own dedicated rail; do not render the chat
  // session list when the user is in canvas mode.
  if (selectedGuild.kind === "canvas") {
    return null
  }
  return (
    <div className="flex h-full flex-col">
      <Header
        selectedGuild={chatGuild}
        team={team ?? null}
        onNewDirect={handleNewDirect}
        onNewTeamConversation={handleNewTeamConversation}
      />
      <Separator />
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {chatGuild.kind === "team" ? t("emptyTeam") : t("emptyDm")}
          </p>
        ) : chatGuild.kind === "team" ? (
          <ul className="flex flex-col gap-0.5 p-2">
            {filtered.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                accentColor={team ? avatarColor(team) : undefined}
                unread={unreadById.get(s.id)}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </ul>
        ) : (
          <DmGroupedList
            groups={dmGroups!}
            characterById={characterById}
            activeSessionId={activeSessionId}
            unreadById={unreadById}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
          />
        )}
      </ScrollArea>
    </div>
  )
}

function Header({
  selectedGuild,
  team,
  onNewDirect,
  onNewTeamConversation,
}: {
  selectedGuild: { kind: "dm" } | { kind: "team"; teamId: string }
  team: Team | null
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
}) {
  const t = useTranslations("desktop.channelList")
  const isTeam = selectedGuild.kind === "team"
  const ctaLabel = isTeam ? t("newConversation") : t("newChat")
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {isTeam ? (
          <UsersIcon
            className="size-4 shrink-0"
            style={{
              color: team ? avatarColor(team) : undefined,
            }}
          />
        ) : (
          <MailIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-semibold tracking-tight">
          {isTeam ? (team?.name ?? t("teamFallback")) : t("directMessages")}
        </span>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => {
          if (selectedGuild.kind === "team") {
            onNewTeamConversation(selectedGuild.teamId)
          } else {
            onNewDirect()
          }
        }}
        aria-label={ctaLabel}
        title={ctaLabel}
      >
        <PlusIcon className="size-4" />
      </Button>
    </div>
  )
}

function DmGroupedList({
  groups,
  characterById,
  activeSessionId,
  unreadById,
  onSelect,
  onDelete,
  onRename,
}: {
  groups: Map<string | null, ChatSession[]>
  characterById: Map<string, Character>
  activeSessionId: string | null
  unreadById: Map<string, number>
  onSelect: (id: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
}) {
  const t = useTranslations("desktop.channelList")
  // Sort: characters with sessions first (alphabetical by name), then "Other".
  const entries = [...groups.entries()].sort((a, b) => {
    if (a[0] === null) return 1
    if (b[0] === null) return -1
    const ca = characterById.get(a[0])?.name ?? ""
    const cb = characterById.get(b[0])?.name ?? ""
    return ca.localeCompare(cb)
  })

  return (
    <div className="flex flex-col gap-3 p-2">
      {entries.map(([characterId, list]) => {
        const character = characterId ? characterById.get(characterId) : null
        const groupName = character?.name ?? t("groupOther")
        return (
          <section key={characterId ?? "other"} aria-label={groupName}>
            <div className="flex items-center gap-2 px-2 pb-1">
              {character ? (
                <AvatarBadge subject={character} size={16} />
              ) : (
                <span className="size-2 rounded-full bg-muted-foreground/40" aria-hidden />
              )}
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {groupName}
              </span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  accentColor={character ? avatarColor(character) : undefined}
                  unread={unreadById.get(s.id)}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
