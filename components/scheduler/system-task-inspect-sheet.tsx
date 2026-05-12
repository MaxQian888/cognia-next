"use client"

/**
 * SystemTaskInspectSheet — Read-only inspection of degraded system tasks.
 * Shows a 3-column comparison of platform-reported data vs. metadata-store
 * data, with optional Edit / Delete actions in the footer.
 *
 * The body has been split into `<SystemTaskInspectBody>` so the unified
 * detail orchestrator (`unified-task-detail-view.tsx`) can embed the same
 * layout inline for the `system` kind without rendering a sheet shell.
 */

import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Pencil, Trash2 } from "lucide-react"
import type { SystemTask } from "@/types/scheduler"
import { InspectRow } from "./details/_shared/inspect-row"

interface SystemTaskInspectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: SystemTask | null
  /** Optional: invoked when the user clicks Edit in the sheet footer. */
  onRequestEdit?: (taskId: string) => void
  /** Optional: invoked when the user clicks Delete in the sheet footer. */
  onRequestDelete?: (taskId: string) => void
}

export interface SystemTaskInspectBodyProps {
  task: SystemTask
}

function formatTrigger(trigger: SystemTask["trigger"]): string {
  switch (trigger.type) {
    case "cron":
      return `cron: ${trigger.expression}`
    case "interval":
      return `interval: ${trigger.seconds}s`
    case "once":
      return `once: ${trigger.run_at}`
    case "on_boot":
      return `on_boot (delay: ${trigger.delay_seconds || 0}s)`
    case "on_logon":
      return `on_logon${trigger.user ? ` (${trigger.user})` : ""}`
    case "on_event":
      return `on_event: ${trigger.source}:${trigger.event_id}`
    default:
      return "-"
  }
}

function formatAction(action: SystemTask["action"]): string {
  switch (action.type) {
    case "execute_script":
      return `script (${action.language})`
    case "run_command":
      return action.command
    case "launch_app":
      return action.path
    default:
      return "-"
  }
}

/**
 * Embeddable body of the system-task inspector. Renders the comparison rows
 * + the degradation banner, but not the sheet shell. Used by both
 * `SystemTaskInspectSheet` and `UnifiedTaskDetailView`.
 */
export function SystemTaskInspectBody({ task }: SystemTaskInspectBodyProps) {
  const t = useTranslations("scheduler")

  return (
    <div className="space-y-4">
      {task.degraded_reasons?.length ? (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-600 mb-1">
            {t("degradedReasons") || "Degradation Reasons"}
          </p>
          {task.degraded_reasons.map((reason, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {reason}
            </p>
          ))}
        </div>
      ) : null}

      <div>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 pb-1.5 border-b border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{t("field") || "Field"}</span>
          <span>{t("platformData") || "Platform"}</span>
          <span>{t("metadataData") || "Metadata"}</span>
        </div>

        <InspectRow
          label={t("systemTaskName") || "Name"}
          value={task.name}
          compareValue={task.name}
        />
        <InspectRow
          label={t("status") || "Status"}
          value={task.status}
          compareValue={task.metadata_state === "full" ? task.status : "unknown"}
        />
        <InspectRow
          label={t("systemTriggerType") || "Trigger"}
          value={formatTrigger(task.trigger)}
          compareValue={
            task.metadata_state === "full" ? formatTrigger(task.trigger) : "(incomplete)"
          }
        />
        <InspectRow
          label={t("systemActionType") || "Action"}
          value={formatAction(task.action)}
          compareValue={task.metadata_state === "full" ? formatAction(task.action) : "(incomplete)"}
        />
        <InspectRow
          label={t("systemRunLevel") || "Run Level"}
          value={task.run_level}
          compareValue={task.run_level}
        />
        {task.next_run_at && (
          <InspectRow
            label={t("nextRun") || "Next Run"}
            value={new Date(task.next_run_at).toLocaleString()}
            compareValue=""
          />
        )}
        {task.last_run_at && (
          <InspectRow
            label={t("lastRun") || "Last Run"}
            value={new Date(task.last_run_at).toLocaleString()}
            compareValue=""
          />
        )}
      </div>
    </div>
  )
}

export function SystemTaskInspectSheet({
  open,
  onOpenChange,
  task,
  onRequestEdit,
  onRequestDelete,
}: SystemTaskInspectSheetProps) {
  const t = useTranslations("scheduler")

  if (!task) return null

  const showFooter = !!onRequestEdit || !!onRequestDelete

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full p-0 overflow-hidden sm:max-w-[520px]"
        showCloseButton
      >
        <SheetHeader className="border-b px-5 pt-5 pb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <SheetTitle className="text-base font-semibold truncate flex-1">
              {t("inspectDegradedTask") || "Inspect Degraded Task"}: {task.name}
            </SheetTitle>
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-4">
          <SystemTaskInspectBody task={task} />

          <div className="pt-2">
            <Badge variant="outline" className="text-amber-500 border-amber-500/20">
              {t("readOnlyInspection") ||
                "Read-only inspection — editing disabled for degraded tasks"}
            </Badge>
          </div>
        </div>

        {showFooter && (
          <div className="border-t px-5 py-3 flex items-center justify-end gap-2">
            {onRequestEdit && (
              <Button
                size="sm"
                variant="outline"
                data-testid="system-inspect-edit"
                onClick={() => {
                  onRequestEdit(task.id)
                  onOpenChange(false)
                }}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {t("edit") || "Edit"}
              </Button>
            )}
            {onRequestDelete && (
              <Button
                size="sm"
                variant="destructive"
                data-testid="system-inspect-delete"
                onClick={() => {
                  onRequestDelete(task.id)
                  onOpenChange(false)
                }}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {t("delete") || "Delete"}
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
