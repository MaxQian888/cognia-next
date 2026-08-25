"use client"

// The notification center panel (ADR-0042) — the content of the status-bar
// bell popover. Lists the active feed (newest-first) grouped into Today /
// Yesterday / Earlier sections, supports source filtering, bulk
// mark-all-read / archive-all / clear-all, an archived view, incremental
// "load more" paging, per-row triage, and opening a notification (navigate via
// href + mark read). Reads the reactive store via `useNotifications`; archived
// rows are loaded on demand.

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  CheckCheckIcon,
  BellOffIcon,
  SettingsIcon,
  MoreVerticalIcon,
  ArchiveIcon,
  Trash2Icon,
  InboxIcon,
  ListFilterIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useNotifications } from "@/hooks/notifications/use-notifications"
import { cn } from "@/lib/utils"
import { dispatchNotificationCommand } from "@/lib/notifications/action-registry"
import { listNotifications } from "@/lib/db/notifications"
import { bucketByRecency } from "@/lib/notifications/recency-buckets"
import {
  NOTIFICATION_SOURCES,
  type NotificationRecord,
  type NotificationSource,
} from "@/types/notifications"
import { NotificationItem } from "./notification-item"

export interface NotificationCenterProps {
  /** Called after navigating (e.g. to close the popover). */
  onNavigate?: () => void
}

/** Rows revealed per page; "load more" grows the window by this many. */
const PAGE_SIZE = 20

function isUnread(r: NotificationRecord): boolean {
  return r.readState === "unseen" || r.readState === "seen"
}

export function NotificationCenter({ onNavigate }: NotificationCenterProps) {
  const t = useTranslations("notificationCenter")
  const router = useRouter()
  const {
    items,
    markSeen,
    markRead,
    markDone,
    restore,
    markAllRead,
    archiveAll,
    snooze,
    remove,
    clearAll,
    sourceFilter,
    setSourceFilter,
    refresh,
  } = useNotifications()

  const [showDone, setShowDone] = useState(false)
  const [doneItems, setDoneItems] = useState<NotificationRecord[]>([])
  const [shownCount, setShownCount] = useState(PAGE_SIZE)
  const [clearOpen, setClearOpen] = useState(false)
  // Stable render-time clock for recency bucketing — boundaries don't tick live.
  const [now] = useState(() => Date.now())

  // Reset the paging window whenever the visible set changes shape (filter
  // change or view switch) so a short list doesn't strand the user mid-scroll.
  // Set-state-during-render is the idiomatic React reset; no effect needed.
  const viewKey = `${showDone}|${sourceFilter ?? ""}`
  const [prevViewKey, setPrevViewKey] = useState(viewKey)
  if (viewKey !== prevViewKey) {
    setPrevViewKey(viewKey)
    setShownCount(PAGE_SIZE)
  }

  const filteredActiveItems = useMemo(
    () => items.filter((record) => !sourceFilter || record.source === sourceFilter),
    [items, sourceFilter]
  )

  // Re-pull the active feed when the panel mounts so snooze-elapsed rows reappear.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Merely surfacing a notification advances unseen → seen. Directed items
  // intentionally remain in the numeric badge until the user reads them.
  useEffect(() => {
    if (showDone) return
    filteredActiveItems.slice(0, shownCount).forEach((record) => {
      if (record.readState === "unseen") void markSeen(record.id)
    })
  }, [filteredActiveItems, markSeen, showDone, shownCount])

  const loadDone = useCallback(() => {
    void listNotifications({ includeDone: true, readStates: ["done"], limit: 100 }).then(
      setDoneItems
    )
  }, [])

  useEffect(() => {
    if (!showDone) return
    loadDone()
  }, [showDone, loadDone])

  const open = useCallback(
    (record: NotificationRecord) => {
      void markRead(record.id)
      if (record.href) {
        router.push(record.href)
        onNavigate?.()
      }
    },
    [markRead, router, onNavigate]
  )

  const runAction = useCallback(
    (record: NotificationRecord, command: string, args?: Record<string, unknown>) => {
      void dispatchNotificationCommand({ notificationId: record.id, command, args })
      void markRead(record.id)
    },
    [markRead]
  )

  const handleArchiveAll = useCallback(() => {
    void archiveAll().then(() => {
      if (showDone) loadDone()
    })
  }, [archiveAll, showDone, loadDone])

  const handleClearAll = useCallback(() => {
    setClearOpen(false)
    void clearAll().then(() => {
      setDoneItems([])
    })
  }, [clearAll])

  const handleRestore = useCallback(
    (id: string) => {
      void restore(id).then(loadDone)
    },
    [restore, loadDone]
  )

  const handleRemove = useCallback(
    (id: string) => {
      void remove(id).then(() => {
        if (showDone) loadDone()
      })
    },
    [remove, showDone, loadDone]
  )

  const visible = showDone
    ? doneItems.filter((r) => !sourceFilter || r.source === sourceFilter)
    : filteredActiveItems
  const empty = visible.length === 0

  // Page the flat list first, then bucket the visible slice so "load more"
  // reveals additional rows within the existing dated sections.
  const paged = useMemo(() => visible.slice(0, shownCount), [visible, shownCount])
  const groups = useMemo(() => bucketByRecency(paged, now), [paged, now])
  const remaining = Math.max(0, visible.length - paged.length)

  // Unread badge reflects the active feed only (archived rows are all read).
  const unreadCount = showDone ? 0 : items.filter(isUnread).length

  return (
    <div
      className="flex max-h-[min(42rem,calc(100vh-3rem))] w-[min(24rem,calc(100vw-1rem))] max-w-full flex-col overflow-hidden"
      data-testid="notification-center"
    >
      <header className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{t("center.title")}</span>
            {unreadCount > 0 && (
              <span
                data-testid="notification-center-unread"
                aria-label={t("center.unreadCount", { count: unreadCount })}
                className="flex min-w-5 shrink-0 items-center justify-center rounded-pill bg-primary px-1.5 text-[10px] font-semibold leading-5 text-primary-foreground"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("center.markAllRead")}
              disabled={showDone || unreadCount === 0}
              onClick={() => void markAllRead()}
            >
              <CheckCheckIcon className="size-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={t("center.moreActions")}
                  data-testid="notification-center-more"
                >
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled={items.length === 0} onClick={handleArchiveAll}>
                  <ArchiveIcon className="size-3.5" />
                  {t("center.archiveAll")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setClearOpen(true)}>
                  <Trash2Icon className="size-3.5" />
                  {t("center.clearAll")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("center.settings")}
              onClick={() => {
                router.push("/settings?section=notifications")
                onNavigate?.()
              }}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="grid min-w-0 grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] items-center gap-2">
          <div className="flex min-w-0 items-center overflow-hidden rounded-lg bg-muted p-0.5">
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 min-w-0 flex-1 gap-1.5 rounded-md px-2 text-xs shadow-none",
                !showDone && "bg-background text-foreground shadow-sm hover:bg-background"
              )}
              aria-pressed={!showDone}
              onClick={() => setShowDone(false)}
            >
              <InboxIcon className="size-3.5 shrink-0" />
              <span className="truncate">{t("center.active")}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 min-w-0 flex-1 gap-1.5 rounded-md px-2 text-xs shadow-none",
                showDone && "bg-background text-foreground shadow-sm hover:bg-background"
              )}
              aria-pressed={showDone}
              onClick={() => setShowDone(true)}
            >
              <ArchiveIcon className="size-3.5 shrink-0" />
              <span className="truncate">{t("center.archived")}</span>
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-2 text-xs font-normal"
              >
                <ListFilterIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {sourceFilter ? t(`sources.${sourceFilter}`) : t("center.filterAll")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuCheckboxItem
                checked={!sourceFilter}
                onCheckedChange={() => setSourceFilter(undefined)}
              >
                {t("center.filterAll")}
              </DropdownMenuCheckboxItem>
              {NOTIFICATION_SOURCES.map((s: NotificationSource) => (
                <DropdownMenuCheckboxItem
                  key={s}
                  checked={sourceFilter === s}
                  onCheckedChange={() => setSourceFilter(s)}
                >
                  {t(`sources.${s}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Separator />

      <ScrollArea className="flex-1">
        {empty ? (
          <div
            className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground"
            data-testid="notification-empty"
          >
            <BellOffIcon className="size-6 opacity-50" aria-hidden />
            <span>{showDone ? t("center.emptyArchived") : t("center.empty")}</span>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.key} data-testid={`notification-bucket-${group.key}`}>
                <h3 className="bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                  {t(`buckets.${group.key}`)}
                </h3>
                <div className="divide-y">
                  {group.items.map((record) => (
                    <NotificationItem
                      key={record.id}
                      record={record}
                      onOpen={open}
                      onMarkRead={(id) => void markRead(id)}
                      onMarkDone={(id) => void markDone(id)}
                      onSnooze={(id, ms) => void snooze(id, ms)}
                      onRemove={handleRemove}
                      onAction={runAction}
                      onRestore={handleRestore}
                      archived={showDone}
                    />
                  ))}
                </div>
              </section>
            ))}
            {remaining > 0 && (
              <div className="p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-full text-xs text-muted-foreground"
                  data-testid="notification-load-more"
                  onClick={() => setShownCount((c) => c + PAGE_SIZE)}
                >
                  {t("center.loadMore", { count: remaining })}
                </Button>
              </div>
            )}
          </>
        )}
      </ScrollArea>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("center.clearAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("center.clearAllBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("center.clearAllCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleClearAll}>
              {t("center.clearAllConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
