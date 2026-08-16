"use client"

import { useCallback, useMemo, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
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
import { useConversationFilterController } from "@/hooks/chat/use-conversation-filter-controller"
import { useChatHistorySearch } from "@/hooks/chat/use-chat-history-search"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { bulkSetSessionsPinned } from "@/lib/db/sessions"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { useUIStore, type ChannelListView } from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import {
  ConversationFilterChips,
  ConversationFilterMenu,
} from "@/components/chat/conversation-filter-controls"
import { conversationSectionKey, UNGROUPED_ID } from "@/lib/chat/conversation-list-model"
import type { DateBucket } from "@/lib/chat/conversation-list-model"
import type {
  Character,
  ChatSession,
  ConversationSidebarDensity,
  ConversationSidebarSettings,
  SessionFolder,
} from "@cognia/agent-config-types"

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
  const exposedSessions = useMemo(() => filterExposedSessions(sessions, "main-list"), [sessions])
  const t = useTranslations("mobile.home")
  const tShell = useTranslations("mobile.shell")
  // Filter vocabulary shared with the desktop sidebar.
  const tFilters = useTranslations("conversationFilters")
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
  // Active ⇄ Archived view + folder collapse — seeded from and written back to
  // the persisted UI store (shared with the desktop sidebar) so the choice
  // survives reloads. Local state keeps re-render cheap on a phone.
  const persistedView = useUIStore((s) => s.channelListView)
  const setPersistedView = useUIStore((s) => s.setChannelListView)
  const [view, setViewState] = useState<ChannelListView>(persistedView)
  const setView = useCallback(
    (next: ChannelListView) => {
      setViewState(next)
      setPersistedView(next)
    },
    [setPersistedView]
  )

  // Straight from the store, like the desktop sidebar (`channel-list.tsx`): a
  // local mirror seeded once could not see the other surface collapse a
  // folder, and wrote its stale copy back over it.
  const persistedCollapsed = useUIStore((s) => s.collapsedFolderIds)
  const toggleCollapsedFolder = useUIStore((s) => s.toggleCollapsedFolder)
  const collapsedFolderIds = useMemo<ReadonlySet<string>>(
    () => new Set(persistedCollapsed),
    [persistedCollapsed]
  )
  const toggleFolder = toggleCollapsedFolder

  // Behavior preferences (Settings → Conversation → sidebar), shared with the
  // desktop sidebar. Absent settings fall back to today's defaults.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const saveSettings = useSettingsStore((s) => s.save)
  const density: ConversationSidebarDensity = sidebarSettings?.density ?? "comfortable"
  const showPreview = sidebarSettings?.showPreview ?? false
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const showUnreadBadges = sidebarSettings?.showUnreadBadges !== false
  const contentScope = sidebarSettings?.searchScope === "titleAndContent"
  // The mobile list has no optimistic save queue: merge the patch into the
  // settings the store currently holds and write straight through.
  const saveSidebarSettings = useCallback(
    (patch: Partial<ConversationSidebarSettings>) =>
      void saveSettings({ conversationSidebar: { ...sidebarSettings, ...patch } }),
    [saveSettings, sidebarSettings]
  )

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
  // `unreadIds` feeds the unread filter/sort and must stay independent of the
  // badge display setting — hiding a badge is a display choice, not a claim
  // that nothing is unread.
  const unreadIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sessionStates ?? []) if (s.unreadCount > 0) ids.add(s.sessionId)
    return ids
  }, [sessionStates])
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    if (!showUnreadBadges) return map
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates, showUnreadBadges])

  // Group axes the pure model can't resolve on its own.
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const contentSearch = useChatHistorySearch(query, {
    enabled: contentScope,
    projectId: groupBy === "workspace" ? undefined : (activeProjectId ?? undefined),
    includeArchived: view === "archived",
    collapseBySession: true,
    limit: 200,
  })
  const contentMatchIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!contentScope || query.trim().length < 2) return undefined
    return new Set(contentSearch.results.map((result) => result.sessionId))
  }, [contentScope, query, contentSearch.results])
  const contentTruncated =
    contentSearch.moreOlderHistory ||
    contentSearch.indexIncomplete ||
    contentSearch.error !== null
  const workspaceGroups = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name })),
    [projects]
  )
  const agentGroups = useMemo(
    () => (characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    [characters]
  )
  const groupCollapseOverrides = useUIStore((s) => s.groupCollapseOverrides)
  const setGroupCollapsed = useUIStore((s) => s.setGroupCollapsed)

  // Sort, quick filters and saved presets are shared with the desktop sidebar —
  // one controller over the same settings blob and UI-store slice — so a phone
  // and a desktop looking at the same profile agree about which conversations
  // exist and in what order.
  const viewSessions = useMemo(
    () =>
      exposedSessions.filter((s) =>
        view === "archived" ? s.archivedAt != null : s.archivedAt == null
      ),
    [exposedSessions, view]
  )
  const filterController = useConversationFilterController({
    sessions: viewSessions,
    workspaces: workspaceGroups,
    folders,
    characters: characters ?? undefined,
    sidebarSettings,
    saveSidebarSettings,
  })
  const { filters, activeFilters, sortBy, filterContext } = filterController
  const resetConversationFilters = filterController.actions.reset

  // Shared grouping model: pinned → folders → the chosen axis, or a flat result
  // list while searching (mirrors the desktop sidebar via the same headless hook).
  const { sections, total, filteredCount } = useConversationListModel({
    sessions: exposedSessions,
    folders: view === "archived" ? undefined : folders,
    query,
    view,
    collapsedFolderIds,
    groupBy,
    sortBy,
    filters,
    unreadIds,
    filterContext,
    workspaces: workspaceGroups,
    agents: agentGroups,
    activeWorkspaceId: activeProjectId,
    groupCollapseOverrides,
    contentMatchIds: contentScope ? contentMatchIds : undefined,
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
    await bulkSetSessionsPinned([session.id], !session.pinned).catch(() => undefined)
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
          density={density}
          showPreview={showPreview}
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
        <ConversationFilterMenu model={filterController} testId="mobile-channel-filter" />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setView(view === "active" ? "archived" : "active")}
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

      <ConversationFilterChips
        model={filterController}
        shown={filteredCount}
        total={total}
        className="border-b border-border px-3 py-1.5"
        testId="mobile-channel-filter-chips"
      />

      <div className="flex-1 overflow-y-auto">
        {contentTruncated && query.trim().length > 0 ? (
          <p
            className="px-4 pt-2 text-center text-[11px] text-muted-foreground"
            role="status"
            data-testid="mobile-channel-search-truncated"
          >
            {t("searchTruncated")}
          </p>
        ) : null}
        {filteredCount === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground" data-testid="mobile-channel-empty">
              {query.trim().length > 0
                ? t("emptyFiltered", { query })
                : activeFilters > 0
                  ? // Distinct from "you have no chats": the exit here is
                    // dropping a filter, not starting a conversation.
                    t("emptyFilters", { count: activeFilters })
                  : archived
                    ? t("emptyArchived")
                    : t("emptyChats")}
            </p>
            {activeFilters > 0 && query.trim().length === 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={resetConversationFilters}
                data-testid="mobile-channel-clear-filters"
              >
                {tFilters("clearAll")}
              </Button>
            ) : null}
          </div>
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
            case "recent":
              return (
                <Section key="recent" testId="mobile-channel-recent">
                  {renderRows(section.sessions)}
                </Section>
              )
            case "group": {
              const key = conversationSectionKey(section)
              const name =
                section.group.id === UNGROUPED_ID
                  ? t(section.axis === "workspace" ? "ungroupedWorkspace" : "ungroupedAgent")
                  : section.group.name
              return (
                <section key={key} data-testid={`mobile-channel-group-${key}`}>
                  <button
                    type="button"
                    onClick={() => setGroupCollapsed(key, !section.collapsed)}
                    aria-expanded={!section.collapsed}
                    aria-label={name}
                    className="flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-left"
                  >
                    {section.collapsed ? (
                      <ChevronRightIcon className="size-3 text-muted-foreground" />
                    ) : (
                      <ChevronDownIcon className="size-3 text-muted-foreground" />
                    )}
                    {section.axis === "workspace" ? (
                      <FolderIcon className="size-3 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <BotIcon className="size-3 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {name}
                    </span>
                  </button>
                  {section.collapsed ? null : (
                    <ul className="flex flex-col">{renderRows(section.sessions)}</ul>
                  )}
                </section>
              )
            }
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
  density,
  showPreview,
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
  density: ConversationSidebarDensity
  showPreview: boolean
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
  const preview = showPreview ? session.lastMessagePreview : undefined
  // Localized "3 minutes ago" via next-intl — the old hand-rolled "3m"/"2d"
  // helper rendered raw English abbreviations for zh-CN users.
  const format = useFormatter()
  const now = useNow()
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
              "h-auto w-full justify-start gap-3 rounded-none px-3 text-left font-normal",
              density === "compact" ? "py-1.5" : "py-2",
              active && "bg-muted/60"
            )}
          >
            <span className="relative shrink-0">
              <Avatar className={density === "compact" ? "size-8" : "size-9"}>
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
                {preview ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {format.relativeTime(new Date(session.lastMessageAt ?? session.updatedAt), now)}
                  </span>
                ) : null}
              </span>
              <span
                className="truncate text-[11px] text-muted-foreground"
                data-testid={`mobile-channel-subtitle-${session.id}`}
              >
                {preview ??
                  format.relativeTime(new Date(session.lastMessageAt ?? session.updatedAt), now)}
              </span>
            </span>
          </Button>
        </LongPress>
      </SwipeRow>
    </motion.li>
  )
}
