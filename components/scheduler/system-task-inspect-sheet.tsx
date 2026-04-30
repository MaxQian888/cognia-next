"use client"

/**
 * SystemTaskInspectSheet - Read-only inspection of degraded system tasks
 * Shows a two-column comparison of platform-reported data vs. metadata-store data.
 */

import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle } from "lucide-react"
import type { SystemTask } from "@/types/scheduler"

interface SystemTaskInspectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: SystemTask | null
}

function InspectRow({
  label,
  platform,
  metadata,
}: {
  label: string
  platform: string
  metadata: string
}) {
  const mismatch = platform !== metadata && platform !== "" && metadata !== ""
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 py-1.5 border-b border-border/40 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <span className={mismatch ? "text-amber-600 font-medium" : ""}>{platform || "-"}</span>
      <span className={mismatch ? "text-amber-600 font-medium" : ""}>{metadata || "-"}</span>
    </div>
  )
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

export function SystemTaskInspectSheet({ open, onOpenChange, task }: SystemTaskInspectSheetProps) {
  const t = useTranslations("scheduler")

  if (!task) return null

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
              platform={task.name}
              metadata={task.name}
            />
            <InspectRow
              label={t("status") || "Status"}
              platform={task.status}
              metadata={task.metadata_state === "full" ? task.status : "unknown"}
            />
            <InspectRow
              label={t("systemTriggerType") || "Trigger"}
              platform={formatTrigger(task.trigger)}
              metadata={
                task.metadata_state === "full" ? formatTrigger(task.trigger) : "(incomplete)"
              }
            />
            <InspectRow
              label={t("systemActionType") || "Action"}
              platform={formatAction(task.action)}
              metadata={task.metadata_state === "full" ? formatAction(task.action) : "(incomplete)"}
            />
            <InspectRow
              label={t("systemRunLevel") || "Run Level"}
              platform={task.run_level}
              metadata={task.run_level}
            />
            {task.next_run_at && (
              <InspectRow
                label={t("nextRun") || "Next Run"}
                platform={new Date(task.next_run_at).toLocaleString()}
                metadata=""
              />
            )}
            {task.last_run_at && (
              <InspectRow
                label={t("lastRun") || "Last Run"}
                platform={new Date(task.last_run_at).toLocaleString()}
                metadata=""
              />
            )}
          </div>

          <div className="pt-2">
            <Badge variant="outline" className="text-amber-500 border-amber-500/20">
              {t("readOnlyInspection") ||
                "Read-only inspection — editing disabled for degraded tasks"}
            </Badge>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
