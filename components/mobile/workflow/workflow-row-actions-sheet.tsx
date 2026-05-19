"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { EyeIcon, PauseIcon, PinIcon, PinOffIcon, PlayIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { enqueue as enqueueOutbound } from "@/lib/db/mobile-outbound-queue"
import { useSettingsStore } from "@/stores/settings"
import type { WorkflowRow } from "@/types/workflow/visual"

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
  const router = useRouter()
  const [deleteOpen, setDeleteOpen] = useState(false)

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

  async function handlePauseSchedule() {
    if (!workflow) return
    // Wave 4 / ADR-0026 — `workflow_schedule_pause` is not yet in the
    // mobile outbound command surface (see lib/db/mobile-outbound-types.ts
    // SOURCE OF TRUTH). For now we toast a deferred-to-desktop hint so
    // the action sheet entry surfaces the intent without enqueuing an
    // RPC that the Rust dispatcher would 404.
    toast.message(t("pauseDeferred"))
    onOpenChange(false)
  }

  function handleViewGraph() {
    if (!workflow) return
    router.push(`/workflows/${encodeURIComponent(workflow.id)}/graph`)
    onOpenChange(false)
  }

  return (
    <>
      <Sheet open={workflow !== null && !deleteOpen} onOpenChange={onOpenChange}>
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
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => void handlePauseSchedule()}
              data-testid="workflow-action-pause"
            >
              <PauseIcon className="size-4" aria-hidden="true" />
              {t("pause")}
            </Button>
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
