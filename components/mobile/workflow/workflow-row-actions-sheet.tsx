"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { EyeIcon, PauseIcon, PinIcon, PinOffIcon, PlayIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { WorkflowGraphViewer, type WorkflowGraph } from "./workflow-graph-viewer"
import { enqueue as enqueueOutbound } from "@/lib/db/mobile-outbound-queue"
import { useSettingsStore } from "@/stores/settings"
import type { WorkflowRow } from "@/types/workflow/visual"

/**
 * Project the persisted React Flow graph into the read-only viewer's shape.
 * Disabled nodes still render — the viewer is about orientation, and hiding
 * them would make the arrow chain lie about the saved graph.
 */
function toViewerGraph(workflow: WorkflowRow): WorkflowGraph {
  return {
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      label: n.data?.label,
      kind: n.type,
      description: typeof n.data?.notes === "string" ? n.data.notes : undefined,
    })),
    edges: workflow.edges.map((e) => ({ from: e.source, to: e.target })),
  }
}

import { WorkflowDeleteConfirm } from "./workflow-delete-confirm"

export interface WorkflowRowActionsSheetProps {
  workflow: WorkflowRow | null
  onOpenChange: (open: boolean) => void
}

/**
 * Long-press action sheet for the mobile workflow list (Wave 4 / ADR-0026).
 *
 * Six actions mirror the desktop right-click menu so muscle memory carries
 * over: Run now / Pause schedule / Pin / View graph / Delete. Each
 * mutation is enqueued via the mobile outbound queue so offline triggers
 * still drain when connectivity returns.
 */
export function WorkflowRowActionsSheet({ workflow, onOpenChange }: WorkflowRowActionsSheetProps) {
  const t = useTranslations("mobile.workflowList.actions")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  // Android hardware / browser back closes the sheet instead of navigating.
  // (Must run before the `!workflow` early return — rules of hooks.)
  useBackDismiss(workflow !== null && !deleteOpen && !graphOpen, () => onOpenChange(false))
  useBackDismiss(graphOpen, () => {
    setGraphOpen(false)
    onOpenChange(false)
  })

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pinnedIds = settings?.pinnedWorkflowIds ?? []
  const isPinned = workflow ? pinnedIds.includes(workflow.id) : false

  if (!workflow) {
    return (
      <Sheet open={false} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" />
      </Sheet>
    )
  }

  async function handleRun() {
    if (!workflow) return
    await enqueueOutbound({
      command: "workflow_trigger_manual",
      payload: { workflowId: workflow.id },
    })
    toast.success(t("runQueued", { name: workflow.name }))
    onOpenChange(false)
  }

  async function handleTogglePin() {
    if (!workflow) return
    const next = isPinned ? pinnedIds.filter((p) => p !== workflow.id) : [...pinnedIds, workflow.id]
    await save({ pinnedWorkflowIds: next })
    toast.success(isPinned ? t("unpinned") : t("pinned"))
    onOpenChange(false)
  }

  // Cron trigger nodes carried in the synced workflow snapshot. The desktop's
  // scheduler mirrors `enabled` into `node.data.disabled` on every flip
  // (see lib/scheduler/sources/workflow-source.ts), so the snapshot is the
  // phone's source of truth for the paused/active state.
  const cronTriggers = workflow.nodes.filter((n) => n.type === "trigger.cron")
  const schedulePaused =
    cronTriggers.length > 0 && cronTriggers.every((n) => n.data?.disabled === true)

  async function handleToggleSchedule() {
    if (!workflow) return
    const command = schedulePaused ? "workflow_schedule_resume" : "workflow_schedule_pause"
    for (const node of cronTriggers) {
      await enqueueOutbound({
        command,
        payload: { triggerId: node.id },
        label: `${schedulePaused ? "Resume" : "Pause"} schedule · ${workflow.name}`,
      })
    }
    toast.success(t(schedulePaused ? "resumeQueued" : "pauseQueued", { name: workflow.name }))
    onOpenChange(false)
  }

  function handleViewGraph() {
    if (!workflow) return
    // The desktop canvas editor is unusable on a phone — open the read-only
    // vertical graph viewer in a bottom sheet instead (Wave 2.9 wiring).
    setGraphOpen(true)
  }

  return (
    <>
      <Sheet open={workflow !== null && !deleteOpen && !graphOpen} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="gap-0 p-0" data-testid="workflow-row-actions-sheet">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle className="text-base">{workflow.name}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 p-3 pb-6">
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => void handleRun()}
              data-testid="workflow-action-run"
            >
              <PlayIcon className="size-4" aria-hidden="true" />
              {t("run")}
            </Button>
            {cronTriggers.length > 0 ? (
              <Button
                variant="ghost"
                className="justify-start"
                onClick={() => void handleToggleSchedule()}
                data-testid="workflow-action-pause"
              >
                {schedulePaused ? (
                  <PlayIcon className="size-4" aria-hidden="true" />
                ) : (
                  <PauseIcon className="size-4" aria-hidden="true" />
                )}
                {schedulePaused ? t("resume") : t("pause")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => void handleTogglePin()}
              data-testid="workflow-action-pin"
            >
              {isPinned ? (
                <PinOffIcon className="size-4" aria-hidden="true" />
              ) : (
                <PinIcon className="size-4" aria-hidden="true" />
              )}
              {isPinned ? t("unpin") : t("favorite")}
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              onClick={handleViewGraph}
              data-testid="workflow-action-graph"
            >
              <EyeIcon className="size-4" aria-hidden="true" />
              {t("graph")}
            </Button>
            <Button
              variant="ghost"
              className="justify-start text-destructive"
              onClick={() => setDeleteOpen(true)}
              data-testid="workflow-action-delete"
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              {t("delete")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={graphOpen}
        onOpenChange={(open) => {
          setGraphOpen(open)
          if (!open) onOpenChange(false)
        }}
      >
        <SheetContent
          side="bottom"
          className="max-h-[85vh] gap-0"
          data-testid="workflow-graph-sheet"
        >
          <SheetHeader className="px-4 pt-4">
            <SheetTitle className="text-base">
              {t("graphSheetTitle", { name: workflow.name })}
            </SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto p-4 pb-6">
            <WorkflowGraphViewer graph={toViewerGraph(workflow)} />
          </div>
        </SheetContent>
      </Sheet>

      <WorkflowDeleteConfirm
        workflow={workflow}
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open)
          if (!open) onOpenChange(false)
        }}
      />
    </>
  )
}
