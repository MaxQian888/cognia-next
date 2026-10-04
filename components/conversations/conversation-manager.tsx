"use client"

/**
 * `/conversations` — the conversation manager (ADR-0213).
 *
 * Where conversation history is looked after rather than read: every
 * conversation in every workspace, in a table that sorts, filters, searches
 * titles or message content, and acts on many rows at once. Two tabs, Active
 * and Archived, split it the way the sidebar's view toggle does; the Archived
 * tab adds "Empty archive" and the auto-archive policy.
 *
 * The sidebar stays the place conversations are *used* from. This page reuses
 * its parts rather than drawing its own: the list model, the filter menu and
 * chips, the row menu, the bulk bar (`layout="bar"`), the empty states and the
 * export / delete / empty-archive dialogs.
 *
 * `?tab=archived` opens the archive — the sidebar's "Manage conversations…"
 * and Settings → Agent runtime → Sessions link here that way.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useNow, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  HistoryIcon,
  PlusIcon,
  SearchIcon,
  TextSearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { ConversationExportDialog } from "@/components/chat/conversation-export-dialog"
import {
  ConversationFilterChips,
  ConversationFilterMenu,
} from "@/components/chat/conversation-filter-controls"
import {
  ConversationListEmptyState,
  ConversationNarrowedEmptyState,
  type SearchWidening,
} from "@/components/chat/conversation-list-empty-state"
import { EmptyArchiveDialog } from "@/components/chat/empty-archive-dialog"
import { ChannelListBulkActions } from "@/components/desktop/channel-list-bulk-actions"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConversationManager } from "@/hooks/conversations/use-conversation-manager"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useSessionUsageSummaries } from "@/hooks/usage/use-session-usage-summaries"
import { useRangeSelection } from "@/hooks/ui/use-range-selection"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { paletteQueryForView } from "@/lib/chat/conversation-archive-view"
import { CONTENT_SEARCH_MIN_QUERY } from "@/lib/chat/conversation-search-scope"
import {
  CONVERSATION_MANAGER_PAGE_SIZE,
  CONVERSATION_MANAGER_TABS,
  conversationManagerHref,
  isConversationManagerTab,
  type ConversationManagerTab,
} from "@/lib/conversations/conversation-manager"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { trackConversationViewChanged } from "@/lib/telemetry/conversation-list-events"
import { cn } from "@/lib/utils"

import { AutoArchiveControl } from "./auto-archive-control"
import { ConversationManagerTable } from "./conversation-manager-table"

export function ConversationManager() {
  const t = useTranslations("conversations.manager")
  const tList = useTranslations("desktop.channelList")
  const tArchive = useTranslations("conversations.archive")
  const router = useRouter()
  const params = useSearchParams()

  // The field owns the immediate value; the model reads the settled one (the
  // same 150 ms the sidebar's field waits), so typing never re-sorts per key.
  const [field, setField] = useState("")
  const [query, setQuery] = useState("")
  const { call: settleQuery, cancel: cancelSettle } = useDebouncedCallback(setQuery, 150)
  const updateField = (value: string) => {
    setField(value)
    if (value.trim() === "") {
      cancelSettle()
      setQuery("")
    } else {
      settleQuery(value)
    }
  }

  const manager = useConversationManager({ query })
  const {
    tab,
    setTab,
    loading,
    counts,
    rows,
    model,
    filterController,
    sortBy,
    setSortBy,
    searchContent,
    setSearchContent,
    content,
    archivedSessions,
    folders,
    unreadCountById,
    runStatusById,
    decorations,
    workspaceNameById,
    rowActions,
    extraActions,
    exportSession,
    closeExport,
    openConversation,
    startConversation,
  } = manager

  // `?tab=` is the address of a tab: applied when it changes, and written back
  // when a tab is picked here, so Back and a copied link both mean something.
  const tabParam = params?.get("tab") ?? null
  useEffect(() => {
    setTab(isConversationManagerTab(tabParam) ? tabParam : "active")
  }, [tabParam, setTab])
  const chooseTab = useCallback(
    (next: ConversationManagerTab) => {
      if (next === tab) return
      void trackConversationViewChanged(next)
      setTab(next)
      router.replace(conversationManagerHref(next))
    },
    [router, setTab, tab]
  )

  // Selection spans the whole view (every filtered row, not the page drawn),
  // and is dropped whenever the view changes under it.
  const selection = useRangeSelection(model.orderedIds)
  const { clear: clearSelection } = selection
  useEffect(() => {
    clearSelection()
  }, [tab, clearSelection])

  const [limit, setLimit] = useState({ for: "", count: CONVERSATION_MANAGER_PAGE_SIZE })
  const viewKey = `${tab}|${query}|${sortBy}|${JSON.stringify(filterController.filters)}`
  const shown = limit.for === viewKey ? limit.count : CONVERSATION_MANAGER_PAGE_SIZE
  const page = useMemo(() => rows.slice(0, shown), [rows, shown])
  const pageIds = useMemo(() => page.map((session) => session.id), [page])
  const { summaries: usage } = useSessionUsageSummaries(pageIds)
  const now = useNow({ updateInterval: 60_000 })

  const [emptyArchiveOpen, setEmptyArchiveOpen] = useState(false)

  // The archive chord the row menus print acts on the focused row. There is
  // no open conversation to fall back to here, unlike the sidebar.
  useAppShortcut(
    "shell.conversation.toggleArchive",
    () => {
      const focused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.closest("[data-conversation-row]")
          : null
      const id = focused?.getAttribute("data-conversation-row")
      const row = id ? manager.sessions.find((session) => session.id === id) : undefined
      if (!row) return
      if (row.archivedAt != null) void rowActions.onUnarchive?.(row.id)
      else void rowActions.onArchive?.(row.id)
    },
    { preventDefault: true }
  )

  const clearSearch = () => updateField("")
  const searchEverywhere = () =>
    requestCommandPalette({ query: paletteQueryForView(query, tab), scope: "chats" })
  const widenings = useMemo<SearchWidening[]>(
    () => (searchContent ? [] : [{ key: "content", patch: { content: true } }]),
    [searchContent]
  )

  const header = (
    <FeaturePageHeader
      icon={<HistoryIcon className="size-5" aria-hidden />}
      title={t("title")}
      description={t("description")}
      summary={
        loading ? undefined : t("summary", { active: counts.active, archived: counts.archived })
      }
      navigation={
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isConversationManagerTab(value)) chooseTab(value)
          }}
        >
          <TabsList aria-label={t("tabsAria")}>
            {CONVERSATION_MANAGER_TABS.map((id) => (
              <TabsTrigger key={id} value={id} data-testid={`conversation-manager-tab-${id}`}>
                {id === "archived" ? <ArchiveIcon className="size-3.5" aria-hidden /> : null}
                {t(`tabs.${id}`)}
                <span
                  className="ml-1 rounded-pill bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums"
                  data-testid={`conversation-manager-tab-count-${id}`}
                >
                  {counts[id]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
      controls={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <InputGroup className="h-8 max-w-md min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon className="size-4" aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              value={field}
              onChange={(event) => updateField(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && field) {
                  event.preventDefault()
                  clearSearch()
                }
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              data-testid="conversation-manager-search"
            />
            {field ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={clearSearch}
                  aria-label={t("searchClear")}
                  data-testid="conversation-manager-search-clear"
                >
                  <XIcon className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={searchContent}
                onPressedChange={setSearchContent}
                aria-label={t("searchContent")}
                className="size-8"
                data-testid="conversation-manager-search-content"
              >
                <TextSearchIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>{t("searchContent")}</TooltipContent>
          </Tooltip>
          <ConversationFilterMenu
            model={filterController}
            side="bottom"
            triggerClassName="size-8 rounded-md"
            testId="conversation-manager-filter"
          />
        </div>
      }
      primaryAction={
        tab === "active"
          ? {
              id: "new-chat",
              label: t("newChat"),
              icon: PlusIcon,
              onSelect: startConversation,
              testId: "conversation-manager-new-chat",
            }
          : {
              id: "empty-archive",
              label: t("emptyArchive"),
              icon: Trash2Icon,
              destructive: true,
              disabled: archivedSessions.length === 0,
              onSelect: () => setEmptyArchiveOpen(true),
              testId: "conversation-manager-empty-archive",
            }
      }
      testId="conversation-manager-header"
    />
  )

  const narrowed = model.total > 0 && model.filteredCount === 0
  const body = loading ? (
    <div className="space-y-2 p-4" aria-busy="true" aria-label={t("loading")}>
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full rounded-md" />
      ))}
    </div>
  ) : model.total === 0 ? (
    <ConversationListEmptyState
      archived={tab === "archived"}
      team={false}
      onCreate={tab === "active" ? startConversation : undefined}
      onShowActive={tab === "archived" ? () => chooseTab("active") : undefined}
      className="flex-1"
    />
  ) : narrowed && !content.pending ? (
    <ConversationNarrowedEmptyState
      query={query.trim()}
      activeFilters={model.activeFilterCount}
      onClearFilters={filterController.actions.reset}
      onClearSearch={clearSearch}
      onSearchEverywhere={searchEverywhere}
      widenings={widenings}
      onWiden={(patch) => {
        if (patch.content) setSearchContent(true)
      }}
    />
  ) : (
    <ConversationManagerTable
      rows={page}
      totalInView={model.orderedIds.length}
      selectedCount={selection.selected.size}
      isSelected={selection.isSelected}
      onToggleSelect={selection.handleClick}
      onSelectAll={selection.selectAll}
      onClearSelection={clearSelection}
      sortBy={sortBy}
      onSortBy={setSortBy}
      decorations={decorations}
      workspaceNameById={workspaceNameById}
      folders={folders}
      usage={usage}
      runStatusById={runStatusById}
      unreadCountById={unreadCountById}
      contentOnlyIds={model.contentOnlyIds}
      now={now}
      rowActions={rowActions}
      extraActions={extraActions}
      onOpen={openConversation}
    />
  )

  return (
    <>
      <FeaturePageShell storageId="conversations" header={header} centerClassName="min-h-0">
        <div className="flex h-full min-h-0 flex-col" data-testid="conversation-manager">
          <div className="space-y-2 px-4 pt-3 empty:hidden">
            {tab === "archived" ? (
              <div
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2"
                data-testid="conversation-manager-archive-panel"
              >
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("archivedNote")}</p>
                <AutoArchiveControl variant="inline" />
              </div>
            ) : null}
            <ConversationFilterChips
              model={filterController}
              shown={model.filteredCount}
              total={model.total}
              testId="conversation-manager-chips"
            />
            <ChannelListBulkActions
              layout="bar"
              visible={selection.selected.size > 0}
              selected={selection.selected}
              orderedIds={model.orderedIds}
              sessions={manager.sessions}
              archived={tab === "archived"}
              onDelete={rowActions.onBulkDelete}
              onSetPinned={rowActions.onBulkSetPinned}
              onArchive={rowActions.onBulkArchive}
              onUnarchive={rowActions.onBulkUnarchive}
              onMarkRead={rowActions.onBulkMarkRead}
              onMarkUnread={rowActions.onBulkMarkUnread}
              unreadIds={manager.unreadIds}
              folders={folders}
              onMoveToFolder={rowActions.onBulkAssignToFolder}
              onSelectAll={selection.selectAll}
              onDeselectAll={clearSelection}
              onClear={clearSelection}
            />
            {content.belowMinQuery ? (
              <p className="text-[11px] text-muted-foreground" role="status">
                {tList("searchContentMinQuery", { count: CONTENT_SEARCH_MIN_QUERY })}
              </p>
            ) : content.failed ? (
              <p className="text-[11px] text-destructive" role="status">
                {tList("searchContentFailed")}
              </p>
            ) : content.pending ? (
              <p className="text-[11px] text-muted-foreground" role="status">
                {tList("searchingMessages")}
              </p>
            ) : content.truncated ? (
              <p className="text-[11px] text-muted-foreground" role="status">
                {tList("searchTruncated")}
              </p>
            ) : null}
          </div>
          <div className={cn("min-h-0 flex-1 overflow-auto", model.total === 0 && "flex")}>
            {body}
            {!loading && rows.length > shown ? (
              <div className="flex flex-col items-center gap-1 pt-2 pb-6">
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {t("shownOf", { shown, total: rows.length })}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setLimit({ for: viewKey, count: shown + CONVERSATION_MANAGER_PAGE_SIZE })
                  }
                  data-testid="conversation-manager-show-more"
                >
                  {t("showMore", {
                    count: Math.min(CONVERSATION_MANAGER_PAGE_SIZE, rows.length - shown),
                  })}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </FeaturePageShell>
      <ConversationExportDialog session={exportSession} onClose={closeExport} />
      <EmptyArchiveDialog
        open={emptyArchiveOpen}
        onOpenChange={setEmptyArchiveOpen}
        sessions={archivedSessions}
        scopeLabel={tArchive("scopeAllWorkspaces")}
      />
    </>
  )
}
