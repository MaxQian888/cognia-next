"use client"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow, useRangeSelection } from "@/hooks/ui"
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { AvatarBadge } from "./avatar-badge"
import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"
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
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  onBulkDelete?: (ids: string[]) => void | Promise<void>
  onBulkSetPinned?: (ids: string[], pinned: boolean) => void | Promise<void>
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

function sortByPinThenRecent(list: ChatSession[]): ChatSession[] {
  // Stable: Array.prototype.sort is stable since ES2019. Pinned bubbles up,
  // ties broken by `updatedAt` newest-first (matching the Dexie ordering).
  return [...list].sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

function ChannelListBody({
  sessions,
  activeSessionId,
  onSelect,
  onNewDirect,
  onNewTeamConversation,
  onDelete,
  onRename,
  onTogglePinned,
  onBulkDelete,
  onBulkSetPinned,
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
  // Apply pinned-on-top sort inside each character group so the pinned
  // marker is observable to the user immediately after a bulk action.
  const dmGroups = useMemo(() => {
    if (chatGuild.kind !== "dm") return null
    const groups = new Map<string | null, ChatSession[]>()
    for (const s of filtered) {
      const key = s.characterId ?? null
      const arr = groups.get(key) ?? []
      arr.push(s)
      groups.set(key, arr)
    }
    for (const [k, list] of groups) groups.set(k, sortByPinThenRecent(list))
    return groups
  }, [filtered, chatGuild])

  // Team branch lays sessions out in pin-then-recent order too.
  const sortedTeamSessions = useMemo(
    () => (chatGuild.kind === "team" ? sortByPinThenRecent(filtered) : []),
    [filtered, chatGuild]
  )

  // Ordered list of visible ids — required for Shift-range to walk the
  // same order as the rendered rows. DM groups are concatenated in the
  // same order `DmGroupedList` iterates (character name asc, then "Other").
  const orderedIds = useMemo<string[]>(() => {
    if (chatGuild.kind === "team") return sortedTeamSessions.map((s) => s.id)
    if (!dmGroups) return []
    const entries = [...dmGroups.entries()].sort((a, b) => {
      if (a[0] === null) return 1
      if (b[0] === null) return -1
      const ca = characterById.get(a[0])?.name ?? ""
      const cb = characterById.get(b[0])?.name ?? ""
      return ca.localeCompare(cb)
    })
    const ids: string[] = []
    for (const [, list] of entries) for (const s of list) ids.push(s.id)
    return ids
  }, [chatGuild, dmGroups, characterById, sortedTeamSessions])

  const selection = useRangeSelection(orderedIds)
  const { selected, handleClick, selectAll, clear, isSelected, lastInteractionWasModified } =
    selection

  // Clear the multi-selection whenever the user pivots to a different
  // guild — the visual context changes and stale "selected" rows would
  // confuse the bulk-toolbar count. `clear` is a stable callback (it's
  // `useCallback(..., [])` inside the hook) so its identity never trips
  // this effect.
  useEffect(() => {
    clear()
  }, [chatGuild, clear])

  const handleNewDirect = () => {
    log.info("channel-list new-direct")
    onNewDirect()
  }
  const handleNewTeamConversation = (teamId: string) => {
    log.info("channel-list new-team-conversation", { teamId })
    onNewTeamConversation(teamId)
  }

  const handleSessionSelect = useCallback(
    (id: string, e: ReactMouseEvent) => {
      const modified = e.ctrlKey || e.metaKey || e.shiftKey
      handleClick(id, e)
      // Plain click activates the session in the chat panel; modifier-bearing
      // clicks only mutate the selection. This mirrors Explorer / Finder.
      if (!modified) {
        onSelect(id)
      }
    },
    [handleClick, onSelect]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const handleContainerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        if (selected.size > 0) {
          e.preventDefault()
          clear()
        }
        return
      }
      const isCtrlA = (e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")
      if (isCtrlA && orderedIds.length > 0) {
        e.preventDefault()
        selectAll()
      }
    },
    [clear, orderedIds.length, selectAll, selected.size]
  )

  // Toolbar visibility: show when ≥2 are selected OR when a single row was
  // selected via a modifier (so the user can still pin/unpin/delete just
  // that one row without round-tripping through the per-row menu). Plain
  // single click — the normal "open this conversation" gesture — never
  // pops the toolbar so it stays out of the way.
  const toolbarVisible = selected.size >= 2 || (selected.size === 1 && lastInteractionWasModified)

  const handleBulkDeleteClick = useCallback(async () => {
    if (!onBulkDelete || selected.size === 0) return
    const ids = [...selected]
    await onBulkDelete(ids)
    clear()
  }, [onBulkDelete, selected, clear])

  const handleBulkSetPinnedClick = useCallback(
    async (pinned: boolean) => {
      if (!onBulkSetPinned || selected.size === 0) return
      const ids = [...selected]
      await onBulkSetPinned(ids, pinned)
      clear()
    },
    [onBulkSetPinned, selected, clear]
  )

  // Canvas guild has its own dedicated rail; do not render the chat
  // session list when the user is in canvas mode.
  if (selectedGuild.kind === "canvas") {
    return null
  }
  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
    >
      <Header
        selectedGuild={chatGuild}
        team={team ?? null}
        onNewDirect={handleNewDirect}
        onNewTeamConversation={handleNewTeamConversation}
      />
      {toolbarVisible ? (
        <ChannelListBulkToolbar
          count={selected.size}
          onDelete={handleBulkDeleteClick}
          onPin={() => handleBulkSetPinnedClick(true)}
          onUnpin={() => handleBulkSetPinnedClick(false)}
          onClear={clear}
        />
      ) : null}
      <Separator />
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {chatGuild.kind === "team" ? t("emptyTeam") : t("emptyDm")}
          </p>
        ) : chatGuild.kind === "team" ? (
          <ul className="flex flex-col gap-0.5 p-2">
            {sortedTeamSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                selected={isSelected(s.id)}
                accentColor={team ? avatarColor(team) : undefined}
                unread={unreadById.get(s.id)}
                onSelect={handleSessionSelect}
                onDelete={onDelete}
                onRename={onRename}
                onTogglePinned={onTogglePinned}
              />
            ))}
          </ul>
        ) : (
          <DmGroupedList
            groups={dmGroups!}
            characterById={characterById}
            activeSessionId={activeSessionId}
            unreadById={unreadById}
            isSelected={isSelected}
            onSelect={handleSessionSelect}
            onDelete={onDelete}
            onRename={onRename}
            onTogglePinned={onTogglePinned}
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
  isSelected,
  onSelect,
  onDelete,
  onRename,
  onTogglePinned,
}: {
  groups: Map<string | null, ChatSession[]>
  characterById: Map<string, Character>
  activeSessionId: string | null
  unreadById: Map<string, number>
  isSelected: (id: string) => boolean
  onSelect: (id: string, e: ReactMouseEvent) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
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
                  selected={isSelected(s.id)}
                  accentColor={character ? avatarColor(character) : undefined}
                  unread={unreadById.get(s.id)}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  onTogglePinned={onTogglePinned}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
