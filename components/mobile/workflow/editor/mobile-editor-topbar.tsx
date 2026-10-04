"use client"

/**
 * Mobile workflow editor top bar. Owns the editor's action chrome:
 *   • back to the library
 *   • workflow name + dirty/saved badge
 *   • read/edit mode toggle (drives structural-editing affordances)
 *
 * Canvas navigation (find node, fit view) lives in the editor's floating map
 * controls instead, so the title keeps room on a phone.
 *   • Run — persists locally (if dirty) then enqueues a manual trigger to the
 *     paired desktop via the same outbound path as the mobile TriggerButton
 *   • overflow: Save, Undo, Redo, Auto-layout, Fit view, Snap, Export, Import
 *
 * Save/Export/Import reuse the shared helpers (`persistEditorWorkflow`,
 * `downloadWorkflowJson`, `parseWorkflowImport`) so there's no second copy of
 * that logic.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import {
  ArrowLeft as BackIcon,
  Play as RunIcon,
  Save as SaveIcon,
  Pencil as EditIcon,
  Eye as ReadIcon,
  Sparkles as CopilotIcon,
  PanelRight as WorkbenchIcon,
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  LayoutGrid as AutoLayoutIcon,
  Maximize2 as FitViewIcon,
  Magnet as SnapIcon,
  BoxSelect as SelectIcon,
  RectangleHorizontal as OrientationIcon,
  Download as ExportIcon,
  Upload as ImportIcon,
  History as HistoryIcon,
  MoreVertical as MoreIcon,
  Check as CheckIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { enqueueUnlessQueued } from "@/lib/db/mobile-outbound-queue"
import { impact } from "@/lib/capacitor/haptics"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { persistEditorWorkflow } from "@/lib/workflow/editor/persist-workflow"
import type { MobileCanvasMode } from "./mobile-canvas"
import { downloadWorkflowJson, parseWorkflowImport } from "@/lib/workflow/editor/workflow-json"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

import type { WorkflowFlowInstance } from "./mobile-canvas"

/**
 * The app's standard 36px icon button (same as the sub-page and list headers),
 * so the bar reads as one set. Only the radius and size come from `Button`.
 */
const BAR_ICON_BUTTON = "shrink-0"
const ACTIVE_TINT = "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"

export interface MobileEditorTopbarProps {
  store: EditorStore
  reactFlowInstance: WorkflowFlowInstance | null
  mode: MobileCanvasMode
  onToggleMode: () => void
  /** Open the AI copilot sheet. */
  onOpenCopilot: () => void
  /** Open the shared Context Workbench. */
  onOpenWorkbench: () => void
  /** Landscape is the editor's default. This is the way out of it. */
  orientationLocked: boolean
  orientationStatus?: "pending" | "locked" | "unlocked" | "unavailable"
  onToggleOrientationLock: () => void
  /** Enter / leave marquee-select, a sub-mode of edit. */
  onToggleSelectMode: () => void
}

export function MobileEditorTopbar({
  store,
  reactFlowInstance,
  mode,
  onToggleMode,
  onOpenCopilot,
  onOpenWorkbench,
  orientationLocked,
  orientationStatus,
  onToggleOrientationLock,
  onToggleSelectMode,
}: MobileEditorTopbarProps) {
  const t = useTranslations("mobile.workflow.editor")
  const tRun = useTranslations("mobile.workflow")
  const tWorkbench = useTranslations("contextWorkbench")

  const { id, name, dirty, snapToGrid } = store(
    useShallow((s: EditorState) => ({
      id: s.baseWorkflow.id,
      name: s.baseWorkflow.name,
      dirty: s.dirty,
      snapToGrid: s.snapToGrid,
    }))
  )

  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  // Mirror temporal availability into local state for the menu's disabled flags.
  useEffect(() => {
    const temporal = store.temporal
    const update = () => {
      const s = temporal.getState()
      setCanUndo(s.pastStates.length > 0)
      setCanRedo(s.futureStates.length > 0)
    }
    update()
    return temporal.subscribe(update)
  }, [store])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    try {
      const { issueCount, publicationInvalidated } = await persistEditorWorkflow(store)
      if (publicationInvalidated) {
        toast.warning(t("publicationInvalidated"))
      } else {
        toast.success(issueCount > 0 ? t("savedWithIssues", { count: issueCount }) : t("saved"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }, [saving, store, t])

  const handleRun = useCallback(async () => {
    if (running) return
    setRunning(true)
    try {
      // Persist the latest edits first so the desktop runs what the user sees,
      // then enqueue a manual trigger for the paired desktop to execute.
      if (store.getState().dirty) await persistEditorWorkflow(store)
      const { id, name: wfName } = store.getState().baseWorkflow
      const { alreadyQueued } = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: id },
        label: wfName,
      })
      void impact("light")
      if (alreadyQueued) toast.message(tRun("runAlreadyQueued"))
      else toast.success(tRun("runQueued"))
    } catch (err) {
      toast.error(tRun("runFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRunning(false)
    }
  }, [running, store, tRun])

  const handleUndo = useCallback(() => store.temporal.getState().undo(), [store])
  const handleRedo = useCallback(() => store.temporal.getState().redo(), [store])
  const handleFitView = useCallback(
    () => reactFlowInstance?.fitView({ duration: 240, padding: 0.2 }),
    [reactFlowInstance]
  )
  const handleToggleSnap = useCallback(
    () => store.getState().setSnapToGrid(!store.getState().snapToGrid),
    [store]
  )

  const handleAutoLayout = useCallback(async () => {
    const { nodes, edges } = store.getState()
    const positions = await autoLayout(nodes, edges)
    if (Object.keys(positions).length === 0) {
      toast.error(t("autoLayoutFailed"))
      return
    }
    store.getState().setNodes(applyAutoLayoutPositions(store.getState().nodes, positions))
    requestAnimationFrame(() => reactFlowInstance?.fitView({ duration: 240, padding: 0.2 }))
  }, [store, reactFlowInstance, t])

  const handleExport = useCallback(() => {
    downloadWorkflowJson(store.getState().toWorkflow())
    toast.success(t("exported"))
  }, [store, t])

  const handleImportClick = useCallback(() => importInputRef.current?.click(), [])
  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = typeof reader.result === "string" ? reader.result : ""
          const parsed = parseWorkflowImport(text)
          store.getState().loadWorkflow(
            {
              ...store.getState().toWorkflow(),
              ...parsed,
              id: store.getState().baseWorkflow.id,
            } as VisualWorkflow,
            { dirty: true }
          )
          toast.success(t("imported"))
        } catch (err) {
          toast.error(err instanceof Error ? `${t("importFailed")}: ${err.message}` : t("importFailed"))
        }
      }
      reader.readAsText(file)
    },
    [store, t]
  )

  return (
    <header className="safe-area-pt flex shrink-0 items-center gap-1 border-b bg-background/95 px-2 py-1.5 backdrop-blur">
      <Button asChild variant="ghost" size="icon" className="shrink-0">
        <Link href="/workflows" aria-label={t("back")}>
          <BackIcon className="size-5" aria-hidden="true" />
        </Link>
      </Button>

      {/* Name over status, both inside the one column that is allowed to
          shrink. The badge used to sit beside the name as `shrink-0`: once the
          action row claimed the whole width this column collapsed to 0px, the
          name vanished and the badge overflowed onto the mode toggle. */}
      {/* The status is a dot and a word rather than a bordered badge: a
          second outlined shape under the title read as one more button. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 pl-0.5">
        <h1 className="w-full truncate text-sm font-semibold leading-tight" title={name}>
          {name}
        </h1>
        <span
          className={cn(
            "flex max-w-full items-center gap-1 truncate text-[11px] leading-none",
            dirty ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"
          )}
          data-testid="mobile-editor-dirty"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              dirty ? "bg-amber-500" : "bg-emerald-500"
            )}
          />
          {dirty ? t("dirty") : t("savedBadge")}
        </span>
      </div>

      {/* Below `sm` (every phone) the mode toggle drops its word (kept for
          screen readers) and the select-mode and Workbench buttons move into
          the overflow menu, so the name column always keeps room. Every action
          is the same 36px icon button; Run is the bar's one filled action, and
          an active mode is a tint so the two never compete. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(BAR_ICON_BUTTON, "sm:w-auto sm:gap-1 sm:px-3", mode !== "read" && ACTIVE_TINT)}
        onClick={onToggleMode}
        aria-pressed={mode === "edit"}
        data-testid="mobile-editor-mode-toggle"
      >
        {mode === "edit" ? (
          <EditIcon className="size-[18px]" aria-hidden="true" />
        ) : (
          <ReadIcon className="size-[18px]" aria-hidden="true" />
        )}
        <span className="max-sm:sr-only">{mode === "edit" ? t("modeEdit") : t("modeRead")}</span>
      </Button>

      {mode !== "read" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(BAR_ICON_BUTTON, "max-sm:hidden", mode === "select" && ACTIVE_TINT)}
          onClick={onToggleSelectMode}
          aria-pressed={mode === "select"}
          aria-label={t("selectMode")}
          data-testid="mobile-editor-select-mode"
        >
          <SelectIcon className="size-[18px]" aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(BAR_ICON_BUTTON, "max-sm:hidden")}
        onClick={onOpenWorkbench}
        aria-label={tWorkbench("mobileTitle")}
        data-testid="mobile-editor-workbench"
      >
        <WorkbenchIcon className="size-[18px]" aria-hidden="true" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={BAR_ICON_BUTTON}
        onClick={handleSave}
        disabled={saving || !dirty}
        aria-label={t("save")}
        data-testid="mobile-editor-save"
      >
        <SaveIcon className="size-[18px]" aria-hidden="true" />
      </Button>

      <Button
        type="button"
        size="icon"
        className={BAR_ICON_BUTTON}
        onClick={handleRun}
        disabled={running}
        aria-label={t("run")}
        data-testid="mobile-editor-run"
      >
        <RunIcon className="size-4" aria-hidden="true" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={BAR_ICON_BUTTON}
            aria-label={t("menu")}
            data-testid="mobile-editor-menu"
          >
            <MoreIcon className="size-[18px]" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {/* The phone-width homes of the two top-bar buttons hidden below
              `sm` (see the mode toggle above). */}
          {mode !== "read" ? (
            <DropdownMenuItem
              onSelect={onToggleSelectMode}
              className="sm:hidden"
              data-testid="mobile-editor-menu-select-mode"
            >
              <SelectIcon className="mr-2 size-4" aria-hidden="true" />
              {t("selectMode")}
              {mode === "select" ? (
                <CheckIcon className="ml-auto size-4" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={onOpenWorkbench}
            className="sm:hidden"
            data-testid="mobile-editor-menu-workbench"
          >
            <WorkbenchIcon className="mr-2 size-4" aria-hidden="true" />
            {tWorkbench("mobileTitle")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="sm:hidden" />
          <DropdownMenuItem onSelect={onOpenCopilot} data-testid="mobile-editor-copilot">
            <CopilotIcon className="mr-2 size-4" aria-hidden="true" />
            {t("copilot")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleUndo} disabled={!canUndo}>
            <UndoIcon className="mr-2 size-4" aria-hidden="true" />
            {t("undo")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRedo} disabled={!canRedo}>
            <RedoIcon className="mr-2 size-4" aria-hidden="true" />
            {t("redo")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleAutoLayout}>
            <AutoLayoutIcon className="mr-2 size-4" aria-hidden="true" />
            {t("autoLayout")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleFitView}>
            <FitViewIcon className="mr-2 size-4" aria-hidden="true" />
            {t("fitView")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleSnap}>
            <SnapIcon className="mr-2 size-4" aria-hidden="true" />
            {snapToGrid ? t("snapOn") : t("snapOff")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onToggleOrientationLock}
            data-testid="mobile-editor-orientation"
            disabled={orientationStatus === "pending" || orientationStatus === "unavailable"}
          >
            <OrientationIcon className="mr-2 size-4" aria-hidden="true" />
            {orientationStatus === "unavailable" ? t("orientationUnavailable") : orientationStatus === "pending" ? t("orientationPending") : orientationLocked ? t("orientationUnlock") : t("orientationLock")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild data-testid="mobile-editor-run-history">
            <Link href={`/workflows/runs?id=${encodeURIComponent(id)}`}>
              <HistoryIcon className="mr-2 size-4" aria-hidden="true" />
              {t("runHistory")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleExport}>
            <ExportIcon className="mr-2 size-4" aria-hidden="true" />
            {t("export")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleImportClick}>
            <ImportIcon className="mr-2 size-4" aria-hidden="true" />
            {t("import")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
        data-testid="mobile-editor-import-input"
      />
    </header>
  )
}
