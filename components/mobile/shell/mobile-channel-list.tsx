"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useClientLiveQuery, useDexieFirstQuery } from "@/hooks/data"
import { useConversationListModel } from "@/hooks/chat/use-conversation-list-model"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { updateSession } from "@/lib/db/sessions"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import type { DateBucket } from "@/lib/chat/conversation-list-model"
import type { Character, ChatSession, SessionFolder } from "@/lib/claude/types"

import { SwipeRow } from "@/components/interactions/swipe-row"
import { LongPress } from "@/components/interactions/long-press"

export interface MobileChannelListProps {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onArchive: (id: string) => void | Promise<void>
  onUnarchive: (id: string) => void | Promise<void>
  /** Conversation folders (display + collapse only on mobile). */
  folders?: SessionFolder[]
}

interface ResolvedSession {
  session: ChatSession
  unread: number
  glyph: string
  color: string
}

/** Maps a date bucket to its `mobile.home` label key. */
const BUCKET_LABEL_KEY: Record<DateBucket, string> = {
  today: "bucketToday",
  yesterday: "bucketYesterday",
  prev7: "bucketPrev7",
  prev30: "bucketPrev30",
  older: "bucketOlder",
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

export function MobileChannelList({
  sessions,
  activeSessionId,
  onSelect,
  onNewDirect,
  onDelete,
  onRename,
  onArchive,
  onUnarchive,
  folders,
}: MobileChannelListProps) {
  const t = useTranslations("mobile.home")
  const tShell = useTranslations("mobile.shell")
  // Search box: keep the field value immediate but debounce the value fed to
  // the grouping model so typing doesn't re-bucket on every keystroke (mirrors
  // the desktop sidebar). buildConversationSections is O(n log n) over all
  // sessions, so on a phone that work must not run per keystroke.
  const [searchInput, setSearchInput] = useState("")
  const [query, setQuery] = useState("")
  const { call: debouncedSetQuery, cancel: cancelDebouncedQuery } = useDebouncedCallback(
    (next: string) => setQuery(next),
    150
  )
  const handleSearchChange = useCallback(
    (next: string) => {
      setSearchInput(next)
      debouncedSetQuery(next)
    },
    [debouncedSetQuery]
  )
  const clearSearch = useCallback(() => {
    setSearchInput("")
    cancelDebouncedQuery()
    setQuery("")
  }, [cancelDebouncedQuery])
  const [view, setView] = useState<"active" | "archived">("active")
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const toggleFolder = useCallback((id: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Wave 4 / ADR-0026 — Dexie-first read so the chip list survives a
  // server drop; `table: "characters"` kicks the sync orchestrator on
  // mount so an offline-then-online transition refreshes the chips.
  const { data: characters } = useDexieFirstQuery<Character[]>({
    query: () => listCharacters(),
    deps: [],
    initial: [],
    table: "characters",
  })
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

  // Shared grouping model: pinned → date buckets, or a flat result list while
  // searching (mirrors the desktop sidebar via the same headless hook).
  const { sections, filteredCount } = useConversationListModel({
    sessions,
    folders: view === "archived" ? undefined : folders,
    query,
    view,
    collapsedFolderIds,
  })
  const archived = view === "archived"

  // Decorate a session with its avatar glyph/color + unread count for rendering.
  const resolve = useCallback(
    (s: ChatSession): ResolvedSession => {
      const ch = s.characterId ? characterById.get(s.characterId) : undefined
      const subject = ch ?? { name: s.title }
      return {
        session: s,
        unread: unreadById.get(s.id) ?? 0,
        glyph: avatarGlyph(subject),
        color: avatarColor(subject),
      }
    },
    [characterById, unreadById]
  )

  const togglePin = async (session: ChatSession) => {
    await updateSession(session.id, { pinned: !session.pinned }).catch(() => undefined)
  }

  const renderRows = (list: ChatSession[]) =>
    list.map((s) => {
      const r = resolve(s)
      return (
        <ChannelRow
          key={s.id}
          resolved={r}
          active={s.id === activeSessionId}
          archived={archived}
          onSelect={() => onSelect(s.id)}
          onTogglePin={() => void togglePin(s)}
          onDelete={() => void onDelete(s.id)}
          onRename={(title) => void onRename(s.id, title)}
          onArchive={() => void onArchive(s.id)}
          onUnarchive={() => void onUnarchive(s.id)}
          pinLabel={s.pinned ? t("swipeUnpin") : t("swipePin")}
          deleteLabel={t("swipeDelete")}
          renameLabel={t("renameAria")}
          archiveLabel={archived ? t("swipeUnarchive") : t("swipeArchive")}
          unreadLabel={t("unreadCount", { count: r.unread })}
        />
      )
    })

  return (
    <div className="flex h-full flex-col" data-testid="mobile-channel-list">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden="true"
            className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t("search")}
            aria-label={t("searchAria")}
            data-testid="mobile-channel-search"
            className="h-9 pl-7 pr-8 text-sm"
          />
          {searchInput.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={tShell("clearSearch")}
              data-testid="mobile-channel-search-clear"
              onClick={clearSearch}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setView((v) => (v === "active" ? "archived" : "active"))}
          aria-label={archived ? t("viewActive") : t("viewArchived")}
          aria-pressed={archived}
          data-testid="mobile-channel-view-toggle"
          className={cn(archived && "text-primary")}
        >
          <ArchiveIcon />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onNewDirect}
          aria-label={tShell("newChat")}
          data-testid="mobile-channel-new"
        >
          <PlusIcon />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filteredCount === 0 ? (
          <p
            className="px-4 py-8 text-center text-xs text-muted-foreground"
            data-testid="mobile-channel-empty"
          >
            {query.trim().length > 0
              ? t("emptyFiltered", { query })
              : archived
                ? t("emptyArchived")
                : t("emptyChats")}
          </p>
        ) : null}

        {sections.map((section) => {
          switch (section.kind) {
            case "pinned":
              return (
                <Section key="pinned" title={t("pinned")} testId="mobile-channel-pinned">
                  {renderRows(section.sessions)}
                </Section>
              )
            case "date":
              return (
                <Section
                  key={`date:${section.bucket}`}
                  title={t(BUCKET_LABEL_KEY[section.bucket])}
                  testId={`mobile-channel-bucket-${section.bucket}`}
                >
                  {renderRows(section.sessions)}
                </Section>
              )
            case "folder":
              return (
                <section
                  key={`folder:${section.folder.id}`}
                  data-testid={`mobile-channel-folder-${section.folder.id}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleFolder(section.folder.id)}
                    aria-expanded={!section.collapsed}
                    aria-label={section.folder.name}
                    className="flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-left"
                  >
                    {section.collapsed ? (
                      <ChevronRightIcon className="size-3 text-muted-foreground" />
                    ) : (
                      <ChevronDownIcon className="size-3 text-muted-foreground" />
                    )}
                    <FolderIcon className="size-3 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {section.folder.name}
                    </span>
                  </button>
                  {section.collapsed ? null : (
                    <ul className="flex flex-col">{renderRows(section.sessions)}</ul>
                  )}
                </section>
              )
            case "search":
              return (
                <Section key="search" testId="mobile-channel-results">
                  {renderRows(section.sessions)}
                </Section>
              )
          }
        })}
      </div>
    </div>
  )
}

function Section({
  title,
  testId,
  children,
}: {
  title?: string
  testId: string
  children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <section data-testid={testId}>
      {title ? (
        <h2 className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <motion.ul
        className="flex flex-col"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {children}
      </motion.ul>
    </section>
  )
}

function ChannelRow({
  resolved,
  active,
  archived,
  onSelect,
  onTogglePin,
  onDelete,
  onRename,
  onArchive,
  onUnarchive,
  pinLabel,
  deleteLabel,
  renameLabel,
  archiveLabel,
  unreadLabel,
}: {
  resolved: ResolvedSession
  active: boolean
  archived: boolean
  onSelect: () => void
  onTogglePin: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onUnarchive: () => void
  pinLabel: string
  deleteLabel: string
  renameLabel: string
  archiveLabel: string
  unreadLabel: string
}) {
  const { session, unread, glyph, color } = resolved
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)

  const commitRename = () => {
    const next = draft.trim()
    if (next && next !== session.title) onRename(next)
    setEditing(false)
  }
  const cancelRename = () => {
    setDraft(session.title)
    setEditing(false)
  }

  // Long-press opens inline rename (pin/delete stay on the swipe actions).
  if (editing) {
    return (
      <motion.li variants={STAGGER_CHILD}>
        <Input
          autoFocus
          value={draft}
          aria-label={renameLabel}
          data-testid={`mobile-channel-rename-${session.id}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commitRename()
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancelRename()
            }
          }}
          className="mx-3 my-1 h-9 w-[calc(100%-1.5rem)] text-sm"
        />
      </motion.li>
    )
  }

  return (
    <motion.li variants={STAGGER_CHILD}>
      <SwipeRow
        rightActions={[
          {
            id: "pin",
            label: pinLabel,
            icon: session.pinned ? (
              <PinOffIcon className="size-3.5" />
            ) : (
              <PinIcon className="size-3.5" />
            ),
            onSelect: onTogglePin,
          },
          {
            id: "archive",
            label: archiveLabel,
            icon: archived ? (
              <ArchiveRestoreIcon className="size-3.5" />
            ) : (
              <ArchiveIcon className="size-3.5" />
            ),
            onSelect: archived ? onUnarchive : onArchive,
          },
          {
            id: "delete",
            label: deleteLabel,
            icon: <Trash2Icon className="size-3.5" />,
            destructive: true,
            onSelect: onDelete,
          },
        ]}
      >
        <LongPress
          onLongPress={() => {
            setDraft(session.title)
            setEditing(true)
          }}
        >
          <Button
            type="button"
            variant="ghost"
            onClick={onSelect}
            data-testid={`mobile-channel-row-${session.id}`}
            data-active={active ? "true" : "false"}
            className={cn(
              "h-auto w-full justify-start gap-3 rounded-none px-3 py-2 text-left font-normal",
              active && "bg-muted/60"
            )}
          >
            <span className="relative shrink-0">
              <Avatar className="size-9">
                <AvatarFallback
                  style={{ backgroundColor: color }}
                  className="text-xs"
                  aria-hidden={glyph.length === 1 ? "true" : undefined}
                >
                  {glyph}
                </AvatarFallback>
              </Avatar>
              {unread > 0 ? (
                <span
                  data-testid={`mobile-channel-unread-${session.id}`}
                  aria-label={unreadLabel}
                  className="absolute -right-0.5 -top-0.5 inline-flex size-2 rounded-full bg-destructive"
                />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1">
                <span className="truncate text-sm font-medium">{session.title}</span>
                {session.pinned ? (
                  <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {relativeTime(session.updatedAt)}
              </span>
            </span>
          </Button>
        </LongPress>
      </SwipeRow>
    </motion.li>
  )
}
