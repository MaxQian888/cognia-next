"use client"

/**
 * Mobile-native scheduler page — surfaces the unified scheduler from the
 * `/me` (Capacitor bottom-nav) entry point.
 *
 * Why this is a separate page from `/scheduler`
 * ---------------------------------------------
 * The desktop `/scheduler` route wraps everything in `SidebarProvider` and a
 * three-pane layout (sidebar + detail + xl rail). On a 375-wide phone, even
 * after the matchMedia breakpoint hides the sidebar, the page still pays the
 * SidebarProvider context cost and the chrome doesn't feel native. This page
 * skips the desktop wrapper entirely: stat strip → kind chips → search →
 * flat list of unified items → push-detail. The data layer (sources
 * registry, `useUnifiedScheduledItems`, `useScheduler`) is shared verbatim.
 *
 * Non-mobile platforms get bounced to `/scheduler` — the full layout is the
 * better experience there.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { buttonVariants } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { MeSection } from "@/components/mobile/me/me-section"
import { FloatingActionButton } from "@/components/ui/floating-action-button"
import { MobileSchedulerStatStrip } from "@/components/mobile/scheduler/mobile-scheduler-stat-strip"
import { FilterChips, SchedulerMobileDetailView, TaskForm } from "@/components/scheduler"
import { KindFilterChips } from "@/components/scheduler/kind-filter-chips"
import { UnifiedTaskSidebarItem } from "@/components/scheduler/unified-task-sidebar-item"
import { useScheduler } from "@/hooks/scheduler"
import { useUnifiedScheduledItems } from "@/hooks/scheduler/use-unified-items"
import { bootstrapSchedulerSources } from "@/lib/scheduler/sources/bootstrap"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"
import {
  SCHEDULED_ITEM_KINDS,
  type ScheduledItemKind,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"
import type { CreateScheduledTaskInput } from "@/types/scheduler"

export default function MobileSchedulerPage() {
  const t = useTranslations("scheduler")
  const tMobile = useTranslations("mobile.me")
  const router = useRouter()
  const platform = usePlatform()

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (platform === "mobile") return
    router.replace("/scheduler")
  }, [mounted, platform, router])

  const {
    statistics,
    selectedTask,
    isInitialized,
    createTask,
    updateTask,
    pauseTask,
    resumeTask,
    runTaskNow,
    selectTask,
    refresh,
    loadRecentExecutions,
    loadUpcomingTasks,
  } = useScheduler()

  useEffect(() => {
    bootstrapSchedulerSources()
  }, [])

  const { items: unifiedItems, countsByKind } = useUnifiedScheduledItems({
    registry: getSchedulerSourceRegistry(),
  })

  useEffect(() => {
    if (isInitialized) {
      loadRecentExecutions(10)
      loadUpcomingTasks(5)
    }
  }, [isInitialized, loadRecentExecutions, loadUpcomingTasks])

  // --- Local UI state ---
  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilter, setActiveFilter] = useState("all")
  const [selectedKinds, setSelectedKinds] = useState<Set<ScheduledItemKind>>(new Set())
  const [selectedUnifiedItem, setSelectedUnifiedItem] = useState<UnifiedScheduledItem | null>(null)
  const [showCreateSheet, setShowCreateSheet] = useState(false)
  const [showEditSheet, setShowEditSheet] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  /**
   * Holds the full unified item being deleted so the confirm dialog can show
   * its display name and route the dispatch through the source registry
   * (kind-aware) rather than the app-only `useScheduler.deleteTask`.
   */
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<UnifiedScheduledItem | null>(null)

  // Derived: filter by search / kind / status
  const visibleItems = useMemo(() => {
    let result = unifiedItems
    if (selectedKinds.size > 0) {
      result = result.filter((item) => selectedKinds.has(item.kind))
    }
    if (activeFilter === "active") result = result.filter((i) => i.status === "active")
    else if (activeFilter === "paused") result = result.filter((i) => i.status === "paused")
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (i) => i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q)
      )
    }
    return result
  }, [unifiedItems, selectedKinds, activeFilter, searchQuery])

  const grouped = useMemo(() => {
    const groups = new Map<ScheduledItemKind, UnifiedScheduledItem[]>()
    for (const kind of SCHEDULED_ITEM_KINDS) groups.set(kind, [])
    for (const item of visibleItems) {
      const bucket = groups.get(item.kind)
      if (bucket) bucket.push(item)
    }
    return Array.from(groups.entries()).filter(([, items]) => items.length > 0)
  }, [visibleItems])

  // --- Handlers ---
  const dispatchUnified = useCallback(
    (action: "runNow" | "pause" | "resume" | "delete") => async (item: UnifiedScheduledItem) => {
      const source = getSchedulerSourceRegistry().getSource(item.kind)
      if (!source) return
      await source[action](item.sourceId)
    },
    []
  )

  const handleSelectItem = useCallback(
    (item: UnifiedScheduledItem) => {
      if (item.kind === "app") {
        selectTask(item.sourceId)
        setSelectedUnifiedItem(null)
      } else {
        selectTask(null)
        setSelectedUnifiedItem(item)
      }
    },
    [selectTask]
  )

  const handleBack = useCallback(() => {
    selectTask(null)
    setSelectedUnifiedItem(null)
  }, [selectTask])

  const handleCreate = useCallback(
    async (input: CreateScheduledTaskInput) => {
      setIsSubmitting(true)
      try {
        await createTask(input)
        setShowCreateSheet(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [createTask]
  )

  /**
   * Edit submit — app-kind tasks only (the same scope as `TaskForm`, which
   * builds a `CreateScheduledTaskInput`). Mirrors the desktop
   * `SchedulerDialogs` edit handler: merge the form output back into the
   * selected task via `updateTask`, clearing the end bound / forward chains
   * when the form returns them empty. Non-app kinds keep their own editors
   * (workflow editor, backup settings, …) and aren't routed here.
   */
  const handleEdit = useCallback(
    async (input: CreateScheduledTaskInput) => {
      if (!selectedTask) return
      setIsSubmitting(true)
      try {
        await updateTask(selectedTask.id, {
          name: input.name,
          description: input.description,
          trigger: input.trigger,
          payload: input.payload,
          notification: input.notification,
          config: input.config,
          tags: input.tags,
          endAt: input.endAt ?? null,
          onSuccessTaskIds: input.onSuccessTaskIds ?? [],
          onFailureTaskIds: input.onFailureTaskIds ?? [],
        })
        setShowEditSheet(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [selectedTask, updateTask]
  )

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmItem) return
    await dispatchUnified("delete")(deleteConfirmItem)
    setDeleteConfirmItem(null)
    handleBack()
  }, [deleteConfirmItem, dispatchUnified, handleBack])

  /**
   * Match the desktop sidebar contract: the row's delete affordance always
   * resolves a `UnifiedScheduledItem`. We stash the full item so the confirm
   * dialog can name it and route the dispatch through the source registry,
   * which delegates to the right backend per kind (app → useScheduler,
   * workflow → workflowDb, backup → schedulerDb backup row, etc.).
   */
  const handleRowDelete = useCallback((item: UnifiedScheduledItem) => {
    setDeleteConfirmItem(item)
  }, [])

  /**
   * SchedulerMobileDetailView's app-kind onDelete contract is `(taskId) =>`.
   * We look the unified item back up so the confirm dialog stays kind-aware.
   * For unified-kind detail views the onUnifiedDelete prop is wired directly
   * to `dispatchUnified("delete")` (immediate), matching desktop semantics.
   */
  const handleAppDetailDelete = useCallback(
    (taskId: string) => {
      const match = unifiedItems.find((it) => it.kind === "app" && it.sourceId === taskId)
      if (match) setDeleteConfirmItem(match)
    },
    [unifiedItems]
  )

  // Prevent flash of mobile chrome on non-mobile platforms during the redirect.
  if (!mounted) return null
  if (platform !== "mobile") return null

  const showingDetail = !!selectedTask || !!selectedUnifiedItem

  return (
    <>
      <SubPageShell
        title={t("title") || tMobile("schedulerRow") || "Scheduler"}
        backAria={tMobile("appearanceBackAria") || "Back"}
        testid="mobile-scheduler-page"
        bodyClassName="space-y-4 px-4 py-4 pb-28"
      >
        <MobileSchedulerStatStrip statistics={statistics} />

        <div className="space-y-2" data-testid="mobile-scheduler-filters">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("searchTasks")}
              aria-label={t("searchTasks")}
              className="h-9 pl-8"
              data-testid="mobile-scheduler-search"
            />
          </div>

          {/*
            The shared chip components carry their own `px-3` (sized for the
            desktop sidebar). Pull the row back by the same amount so the first
            chip aligns flush with the search box / stat cards instead of
            sitting visibly indented on the phone.
          */}
          <div className="-mx-3">
            <FilterChips
              filters={[
                { key: "all", label: t("filter.all") || "All", count: unifiedItems.length },
                {
                  key: "active",
                  label: t("statuses.active") || "Active",
                  count: unifiedItems.filter((i) => i.status === "active").length,
                },
                {
                  key: "paused",
                  label: t("statuses.paused") || "Paused",
                  count: unifiedItems.filter((i) => i.status === "paused").length,
                },
              ]}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
            />

            <KindFilterChips
              selected={selectedKinds}
              onToggle={(kind) => {
                const next = new Set(selectedKinds)
                if (next.has(kind)) next.delete(kind)
                else next.add(kind)
                setSelectedKinds(next)
              }}
              onClear={() => setSelectedKinds(new Set())}
              countsByKind={countsByKind}
            />
          </div>
        </div>

        {grouped.length === 0 ? (
          <p
            className="py-10 text-center text-sm text-muted-foreground"
            data-testid="mobile-scheduler-empty"
          >
            {searchQuery || activeFilter !== "all" || selectedKinds.size > 0
              ? t("emptyFiltered") || "No matching tasks"
              : t("emptyTitle") || "No scheduled tasks yet"}
          </p>
        ) : (
          <div className="space-y-3" data-testid="mobile-scheduler-list">
            {grouped.map(([kind, items]) => (
              <MeSection
                key={kind}
                title={t(`kindFilter.${kind}`) || kind}
                testid={`mobile-scheduler-group-${kind}`}
              >
                {/*
                  Mobile scheduler shell: `MeSection` (canonical /me/* grouping) wraps
                  `UnifiedTaskSidebarItem` rows. The row body stays shared with the
                  desktop scheduler — it carries a status dot + a dropdown menu
                  (run / pause / edit / delete) that `MeRow` cannot express without
                  losing functionality. The outer `SubPageShell + MeSection` chrome
                  gives this page the same visual cadence as the rest of `/me/*`.
                */}
                {items.map((item) => (
                  <UnifiedTaskSidebarItem
                    key={item.unifiedId}
                    item={item}
                    isActive={
                      selectedUnifiedItem?.unifiedId === item.unifiedId ||
                      (item.kind === "app" && selectedTask?.id === item.sourceId)
                    }
                    onClick={handleSelectItem}
                    onRunNow={dispatchUnified("runNow")}
                    onPause={dispatchUnified("pause")}
                    onResume={dispatchUnified("resume")}
                    onDelete={handleRowDelete}
                  />
                ))}
              </MeSection>
            ))}
          </div>
        )}
      </SubPageShell>

      {/* FAB → create new task. Anchored to viewport so it stays visible while
          the list scrolls. The default FAB offset only clears the safe-area;
          on `/me/*` the fixed `MobileTabBar` (h-14 + safe-area) is still
          mounted, so lift the FAB above it — `theme(spacing.14)` matches the
          shell's `pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]`
          reservation — to stop it covering the bottom nav / "我" tab. */}
      {!showingDetail && (
        <FloatingActionButton
          aria-label={t("mobile.fabCreateAria") || t("createTask") || "Create task"}
          data-testid="mobile-scheduler-fab"
          className="bottom-[calc(theme(spacing.14)+env(safe-area-inset-bottom,0px)+1rem)]"
          onClick={() => setShowCreateSheet(true)}
        />
      )}

      {/* Full-screen detail push. Renders above SubPageShell when an item is
          selected. */}
      {showingDetail && (
        <div
          className="fixed inset-0 z-40 flex flex-col bg-background"
          data-testid="mobile-scheduler-detail-overlay"
        >
          <SchedulerMobileDetailView
            task={selectedTask ?? undefined}
            unifiedItem={selectedTask ? undefined : (selectedUnifiedItem ?? undefined)}
            onBack={handleBack}
            onPause={pauseTask}
            onResume={resumeTask}
            onRunNow={runTaskNow}
            onDelete={handleAppDetailDelete}
            onEdit={() => {
              // App-kind tasks edit in-place via the same `TaskForm` the create
              // sheet uses (prefilled from `selectedTask`). Non-app kinds never
              // reach this callback — their detail view omits the edit action.
              if (selectedTask) setShowEditSheet(true)
            }}
            onUnifiedRunNow={dispatchUnified("runNow")}
            onUnifiedPause={dispatchUnified("pause")}
            onUnifiedResume={dispatchUnified("resume")}
            onUnifiedDelete={dispatchUnified("delete")}
          />
        </div>
      )}

      {/* Create-task sheet. Slides in from the right (desktop) or the bottom
          (small breakpoint via shadcn defaults). */}
      <Sheet open={showCreateSheet} onOpenChange={setShowCreateSheet}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          data-testid="mobile-scheduler-create-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("createTask") || "Create task"}</SheetTitle>
            <SheetDescription>
              {t("createTaskDescription") || "Set up a new scheduled task"}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <TaskForm
              onSubmit={handleCreate}
              onCancel={() => setShowCreateSheet(false)}
              isSubmitting={isSubmitting}
              existingTasks={[]}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Edit-task sheet — app-kind only, prefilled from the selected task.
          Mirrors the desktop `SchedulerDialogs` edit sheet but reuses the
          mobile slide-in chrome. */}
      <Sheet open={showEditSheet} onOpenChange={setShowEditSheet}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          data-testid="mobile-scheduler-edit-sheet"
        >
          <SheetHeader>
            <SheetTitle>{t("editTask")}</SheetTitle>
            <SheetDescription>{t("editTaskDescription")}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {selectedTask ? (
              <TaskForm
                initialValues={{
                  name: selectedTask.name,
                  description: selectedTask.description,
                  type: selectedTask.type,
                  trigger: selectedTask.trigger,
                  payload: selectedTask.payload,
                  config: selectedTask.config,
                  notification: selectedTask.notification,
                  endAt: selectedTask.endAt,
                  onSuccessTaskIds: selectedTask.onSuccessTaskIds,
                  onFailureTaskIds: selectedTask.onFailureTaskIds,
                }}
                onSubmit={handleEdit}
                onCancel={() => setShowEditSheet(false)}
                isSubmitting={isSubmitting}
                existingTasks={[]}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirmation — shadcn AlertDialog (matches the desktop
          `SchedulerDialogs` pattern). The unified item context lets the
          title interpolate the task name so users can tell what they're
          about to delete. */}
      <AlertDialog
        open={!!deleteConfirmItem}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmItem(null)
        }}
      >
        <AlertDialogContent data-testid="mobile-scheduler-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTaskConfirm") || "Are you sure you want to delete this task?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmItem?.name
                ? `${deleteConfirmItem.name} — ${t("deleteTask") || "Delete task"}`
                : t("deleteTask") || "Delete task"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="mobile-scheduler-delete-cancel">
              {t("cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="mobile-scheduler-delete-confirm-button"
              onClick={handleConfirmDelete}
              className={cn(buttonVariants({ variant: "destructive" }))}
            >
              {t("delete") || "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pull-to-refresh-like manual refresh hook — exposed via a hidden
          accessible button. The connector / sync layer keeps Dexie reads
          live, so most users never need this, but a manual control is wired
          for parity with the desktop refresh menu. */}
      <button
        type="button"
        onClick={() => refresh()}
        className="sr-only"
        aria-label={t("refresh") || "Refresh"}
        data-testid="mobile-scheduler-refresh"
      />
    </>
  )
}
