"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { WorkflowIcon } from "lucide-react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { Skeleton } from "@/components/ui/skeleton"
import { listChildFolders, getFolderPath } from "@/lib/db/workflow-folders"
import {
  createWorkflow,
  getLastRunStatuses,
  getRecentlyFailedWorkflowIds,
  getRunCounts,
  listWorkflowsInFolder,
  moveWorkflowsToFolder,
} from "@/lib/db/workflows"
import { parseWorkflowsImport } from "@/lib/workflow/editor/workflow-json"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import {
  filterWorkflows,
  isFilterActive,
  resolveDragMoveIds,
  sortWorkflows,
} from "@/lib/workflow/library-filter"
import { useUIStore } from "@/stores/ui/ui-store"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowCreateDialog } from "./workflow-create-dialog"
import { WorkflowCreateFolderDialog } from "./workflow-create-folder-dialog"
import { WorkflowMoveToFolderDialog } from "./workflow-move-to-folder-dialog"
import { WorkflowDeleteDialog } from "./workflow-delete-dialog"
import { WorkflowBulkTagDialog } from "./workflow-bulk-tag-dialog"
import { WorkflowBulkActionBar } from "./workflow-bulk-action-bar"
import { WorkflowLibraryToolbar } from "./workflow-library-toolbar"
import { WorkflowFolderBreadcrumb } from "./workflow-folder-breadcrumb"
import { WorkflowPinnedSection } from "./workflow-pinned-section"
import { WorkflowLibraryGrid } from "./workflow-library-grid"
import { WorkflowLibraryList } from "./workflow-library-list"
import { WorkflowLibraryEmpty } from "./workflow-library-empty"
import { LibraryStatBar } from "./library-stat-bar"

const RECENTLY_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
// Stable empty fallbacks so the `visible` memo isn't busted by a fresh
// Set/Map identity on every render while a live query is still pending.
const EMPTY_FAILED_IDS: ReadonlySet<string> = new Set<string>()
const EMPTY_RUN_COUNTS: ReadonlyMap<string, number> = new Map<string, number>()
const EMPTY_STATUSES: ReadonlyMap<string, import("@/types/workflow/visual").RunStatus> = new Map()

export function WorkflowLibrary() {
  const t = useTranslations("workflows.library")
  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)
  const viewMode = useWorkflowLibraryStore((s) => s.viewMode)
  const sort = useWorkflowLibraryStore((s) => s.sort)
  const filters = useWorkflowLibraryStore((s) => s.filters)
  const query = useWorkflowLibraryStore((s) => s.query)
  const goToRoot = useWorkflowLibraryStore((s) => s.goToRoot)
  const resetFilters = useWorkflowLibraryStore((s) => s.resetFilters)

  const childFolders = useLiveQuery(() => listChildFolders(currentFolderId), [currentFolderId])
  const folderPath = useLiveQuery(() => getFolderPath(currentFolderId), [currentFolderId])
  const folderWorkflows = useLiveQuery(
    () => listWorkflowsInFolder(currentFolderId),
    [currentFolderId]
  )

  const recentlyFailedIds = useLiveQuery(
    () =>
      filters.recentlyFailed
        ? getRecentlyFailedWorkflowIds(Date.now() - RECENTLY_FAILED_WINDOW_MS)
        : Promise.resolve(EMPTY_FAILED_IDS as Set<string>),
    [filters.recentlyFailed]
  )

  // Run counts + last-run status power both the runCount sort and the per-card
  // badges, so compute them whenever the folder's workflows change.
  const runCounts = useLiveQuery(
    () =>
      folderWorkflows
        ? getRunCounts(folderWorkflows.map((w) => w.id))
        : Promise.resolve(EMPTY_RUN_COUNTS as Map<string, number>),
    [folderWorkflows]
  )
  const lastStatuses = useLiveQuery(
    () =>
      folderWorkflows
        ? getLastRunStatuses(folderWorkflows.map((w) => w.id))
        : Promise.resolve(
            EMPTY_STATUSES as Map<string, import("@/types/workflow/visual").RunStatus>
          ),
    [folderWorkflows]
  )

  const visible = useMemo(() => {
    if (!folderWorkflows) return undefined
    const failed = recentlyFailedIds ?? EMPTY_FAILED_IDS
    const counts = runCounts ?? EMPTY_RUN_COUNTS
    const filtered = filterWorkflows(folderWorkflows, {
      query,
      filters,
      recentlyFailedIds: failed as Set<string>,
    })
    return sortWorkflows(filtered, sort, counts as Map<string, number>)
  }, [folderWorkflows, query, filters, recentlyFailedIds, sort, runCounts])

  // Folder removed elsewhere (live query) — never strand the user inside it.
  // `goToRoot` is a store action, not a local setState, so this is safe in an
  // effect.
  useEffect(() => {
    if (currentFolderId !== ROOT_FOLDER_ID && folderPath !== undefined && folderPath.length === 0) {
      goToRoot()
      toast.message(t("folders.removedToast"))
    }
  }, [currentFolderId, folderPath, goToRoot, t])

  // Create-workflow dialog. The File → New Workflow menu sets a ui-store flag;
  // deriving `open` from it (rather than mirroring into state via an effect)
  // keeps the open logic declarative.
  const [localCreateOpen, setLocalCreateOpen] = useState(false)
  const pendingCreate = useUIStore((s) => s.pendingCreateRequest)
  const clearPendingCreate = useUIStore((s) => s.clearPendingCreate)
  const pendingWorkflowCreate = pendingCreate?.kind === "workflow"
  const createOpen = localCreateOpen || pendingWorkflowCreate
  const handleCreateOpenChange = (open: boolean) => {
    setLocalCreateOpen(open)
    if (!open && pendingWorkflowCreate) clearPendingCreate()
  }

  // Drag-and-drop: move workflows into folders / breadcrumb destinations.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  )
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const draggingWorkflow = useMemo(
    () => (draggingId ? (visible?.find((w) => w.id === draggingId) ?? null) : null),
    [visible, draggingId]
  )

  // Import one or more workflow JSON files (single workflow or a `{ workflows }`
  // bundle) into the current folder. Each valid workflow becomes a fresh row.
  const handleImportFiles = async (files: FileList) => {
    let imported = 0
    let failed = 0
    for (const file of Array.from(files)) {
      try {
        const text = await readFileText(file)
        const parsed = parseWorkflowsImport(text)
        for (const wf of parsed) {
          await createWorkflow({
            ...wf,
            name: wf.name ?? "Imported workflow",
            folderId: currentFolderId,
            // A publication belongs to the exported workflow id/tool name.
            // Import the callable interface, then require an explicit publish
            // for the fresh row to avoid two definitions claiming one tool.
          })
          imported += 1
        }
      } catch {
        failed += 1
      }
    }
    if (imported > 0) toast.success(t("import.success", { count: imported }))
    if (failed > 0) toast.error(t("import.failed", { count: failed }))
    if (imported === 0 && failed === 0) toast.message(t("import.empty"))
  }

  const handleDragStart = (event: DragStartEvent) => {
    const wfId = event.active.data.current?.workflowId
    if (typeof wfId === "string") setDraggingId(wfId)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setDraggingId(null)
    const overFolderId = event.over?.data.current?.folderId
    const wfId = event.active.data.current?.workflowId
    if (typeof overFolderId !== "string" || typeof wfId !== "string") return
    const ids = resolveDragMoveIds(wfId, useWorkflowLibraryStore.getState().selection)
    try {
      await moveWorkflowsToFolder(ids, overFolderId)
      toast.success(t("move.moved", { count: ids.length }))
      useWorkflowLibraryStore.getState().clearSelection()
    } catch {
      toast.error(t("move.moveFailed"))
    }
  }

  const isLoading =
    childFolders === undefined || folderWorkflows === undefined || visible === undefined
  const isEmpty = !isLoading && visible.length === 0 && childFolders.length === 0
  const emptyVariant = isFilterActive(query, filters)
    ? "filtered"
    : currentFolderId === ROOT_FOLDER_ID
      ? "root"
      : "folder"

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b px-6 py-4">
          <span className="rounded-md bg-primary/10 p-2 text-primary">
            <WorkflowIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
        </header>
        <LibraryStatBar />
        <WorkflowBulkActionBar />
        <WorkflowLibraryToolbar
          onNewWorkflow={() => setLocalCreateOpen(true)}
          onImportFiles={handleImportFiles}
        />
        <div className="border-b px-6 py-2">
          <WorkflowFolderBreadcrumb path={folderPath ?? []} />
        </div>
        {currentFolderId === ROOT_FOLDER_ID ? (
          <div className="max-h-[40%] shrink-0 overflow-y-auto">
            <WorkflowPinnedSection />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {isLoading ? (
            <LibrarySkeleton />
          ) : isEmpty ? (
            <WorkflowLibraryEmpty
              variant={emptyVariant}
              onCreate={() => setLocalCreateOpen(true)}
              onClearFilters={resetFilters}
            />
          ) : viewMode === "grid" ? (
            <WorkflowLibraryGrid
              folders={childFolders}
              workflows={visible}
              runCounts={runCounts ?? EMPTY_RUN_COUNTS}
              lastStatuses={lastStatuses ?? EMPTY_STATUSES}
            />
          ) : (
            <WorkflowLibraryList
              folders={childFolders}
              workflows={visible}
              runCounts={runCounts ?? EMPTY_RUN_COUNTS}
              lastStatuses={lastStatuses ?? EMPTY_STATUSES}
            />
          )}
        </div>
      </div>

      <DragOverlay>
        {draggingWorkflow ? (
          <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-md">
            <WorkflowIcon className="size-4 text-primary" aria-hidden="true" />
            <span className="font-medium">{draggingWorkflow.name}</span>
          </div>
        ) : null}
      </DragOverlay>

      <WorkflowCreateDialog
        open={createOpen}
        onOpenChange={handleCreateOpenChange}
        parentFolderId={currentFolderId}
      />
      <WorkflowCreateFolderDialog />
      <WorkflowMoveToFolderDialog />
      <WorkflowDeleteDialog />
      <WorkflowBulkTagDialog />
    </DndContext>
  )
}

/**
 * Read a File as UTF-8 text via FileReader — reliable across browsers, the
 * Tauri webview, and jsdom (whose Blob.text() doesn't settle under tests).
 */
function readFileText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsText(file)
  })
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 px-6 py-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-32 rounded-lg" />
      ))}
    </div>
  )
}
