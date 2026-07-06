"use client"

/**
 * Mobile workflow editor top bar. Owns the editor's action chrome:
 *   • back to the library
 *   • workflow name + dirty/saved badge
 *   • read/edit mode toggle (drives structural-editing affordances)
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
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  LayoutGrid as AutoLayoutIcon,
  Maximize2 as FitViewIcon,
  Magnet as SnapIcon,
  Download as ExportIcon,
  Upload as ImportIcon,
  History as HistoryIcon,
  MoreVertical as MoreIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { impact } from "@/lib/capacitor/haptics"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { persistEditorWorkflow } from "@/lib/workflow/editor/persist-workflow"
import { downloadWorkflowJson, parseWorkflowImport } from "@/lib/workflow/editor/workflow-json"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

import type { WorkflowFlowInstance } from "./mobile-canvas"

export interface MobileEditorTopbarProps {
  store: EditorStore
  reactFlowInstance: WorkflowFlowInstance | null
  mode: "read" | "edit"
  onToggleMode: () => void
  /** Open the AI copilot sheet. */
  onOpenCopilot: () => void
}

export function MobileEditorTopbar({
  store,
  reactFlowInstance,
  mode,
  onToggleMode,
  onOpenCopilot,
}: MobileEditorTopbarProps) {
  const t = useTranslations("mobile.workflow.editor")
  const tRun = useTranslations("mobile.workflow")

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
      const issueCount = await persistEditorWorkflow(store)
      toast.success(issueCount > 0 ? t("savedWithIssues", { count: issueCount }) : t("saved"))
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
      await enqueue({
        command: "workflow_trigger_manual",
        payload: { workflowId: id },
        label: wfName,
      })
      void impact("light")
      toast.success(tRun("runQueued"))
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
          store.getState().loadWorkflow({
            ...store.getState().toWorkflow(),
            ...parsed,
            id: store.getState().baseWorkflow.id,
          } as VisualWorkflow)
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
      <Button asChild variant="ghost" size="icon" className="size-11 shrink-0">
        <Link href="/workflows" aria-label={t("back")}>
          <BackIcon className="size-5" aria-hidden="true" />
        </Link>
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h1 className="truncate text-sm font-semibold leading-tight">{name}</h1>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 text-[10px]",
              dirty ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"
            )}
            data-testid="mobile-editor-dirty"
          >
            {dirty ? t("dirty") : t("savedBadge")}
          </Badge>
        </div>
      </div>

      <Button
        type="button"
        variant={mode === "edit" ? "default" : "outline"}
        size="sm"
        className="min-h-11 shrink-0"
        onClick={onToggleMode}
        aria-pressed={mode === "edit"}
        data-testid="mobile-editor-mode-toggle"
      >
        {mode === "edit" ? (
          <EditIcon className="mr-1 size-4" aria-hidden="true" />
        ) : (
          <ReadIcon className="mr-1 size-4" aria-hidden="true" />
        )}
        {mode === "edit" ? t("modeEdit") : t("modeRead")}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        onClick={onOpenCopilot}
        aria-label={t("copilot")}
        data-testid="mobile-editor-copilot"
      >
        <CopilotIcon className="size-5" aria-hidden="true" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        onClick={handleSave}
        disabled={saving || !dirty}
        aria-label={t("save")}
        data-testid="mobile-editor-save"
      >
        <SaveIcon className="size-5" aria-hidden="true" />
      </Button>

      <Button
        type="button"
        size="icon"
        className="size-11 shrink-0"
        onClick={handleRun}
        disabled={running}
        aria-label={t("run")}
        data-testid="mobile-editor-run"
      >
        <RunIcon className="size-5" aria-hidden="true" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t("menu")}
            data-testid="mobile-editor-menu"
          >
            <MoreIcon className="size-5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
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
