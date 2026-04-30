"use client"

import { AlertTriangle, Info, Shield, ShieldAlert, ShieldCheck, Terminal } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { TaskConfirmationRequest } from "@/types/scheduler"

export interface TaskConfirmationDialogProps {
  confirmation: TaskConfirmationRequest | null
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  loading?: boolean
}

export function TaskConfirmationDialog({
  confirmation,
  open,
  onConfirm,
  onCancel,
  loading = false,
}: TaskConfirmationDialogProps) {
  const t = useTranslations("scheduler")
  const [understood, setUnderstood] = useState(false)

  if (!confirmation) return null

  const isCritical = confirmation.risk_level === "critical"
  const isHighRisk = confirmation.risk_level === "high" || isCritical

  const operationLabelMap: Record<string, string> = {
    create: t("operationCreate") || "Create Task",
    update: t("operationUpdate") || "Update Task",
    delete: t("operationDelete") || "Delete Task",
    enable: t("operationEnable") || "Enable Task",
    run_now: t("operationRunNow") || "Run Task Now",
  }
  const operationLabel =
    operationLabelMap[confirmation.operation] || t("operationDefault") || "Task Operation"

  const getRiskIcon = () => {
    switch (confirmation.risk_level) {
      case "low":
        return <ShieldCheck className="h-5 w-5 text-green-500" />
      case "medium":
        return <Shield className="h-5 w-5 text-yellow-500" />
      case "high":
        return <ShieldAlert className="h-5 w-5 text-orange-500" />
      case "critical":
        return <AlertTriangle className="h-5 w-5 text-red-500" />
      default:
        return <Info className="h-5 w-5" />
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {getRiskIcon()}
            <span>{operationLabel}</span>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {/* Task name */}
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-1">
                  <span className="text-sm font-medium">{confirmation.details.task_name}</span>
                  {(confirmation.target_task_id || confirmation.task_id) && (
                    <div className="text-muted-foreground text-[11px] font-mono">
                      {confirmation.target_task_id || confirmation.task_id}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    variant={isCritical ? "destructive" : isHighRisk ? "secondary" : "outline"}
                  >
                    {t(`riskLevels.${confirmation.risk_level}`)}
                  </Badge>
                  <span className="text-muted-foreground text-[10px] font-mono">
                    {confirmation.confirmation_id}
                  </span>
                </div>
              </div>

              <div className="text-muted-foreground grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  {t("createdAt") || "Created"}:{" "}
                  {new Date(confirmation.created_at).toLocaleString()}
                </div>
                <div className="text-right">
                  {t("expiresAt") || "Expires"}:{" "}
                  {new Date(confirmation.expires_at).toLocaleString()}
                </div>
              </div>

              {/* Action summary */}
              {confirmation.details.action_summary && (
                <div className="space-y-1">
                  <span className="text-muted-foreground text-xs">{t("action") || "Action"}</span>
                  <p className="text-sm">{confirmation.details.action_summary}</p>
                </div>
              )}

              {/* Trigger summary */}
              {confirmation.details.trigger_summary && (
                <div className="space-y-1">
                  <span className="text-muted-foreground text-xs">{t("trigger") || "Trigger"}</span>
                  <p className="text-sm">{confirmation.details.trigger_summary}</p>
                </div>
              )}

              {/* Script preview */}
              {confirmation.details.script_preview && (
                <div className="space-y-1">
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Terminal className="h-3 w-3" />
                    {t("scriptPreview") || "Script Preview"}
                  </span>
                  <ScrollArea className="h-24 rounded-md border">
                    <pre className="bg-muted p-2 font-mono text-xs">
                      {confirmation.details.script_preview}
                    </pre>
                  </ScrollArea>
                </div>
              )}

              {/* Warnings */}
              {confirmation.warnings.length > 0 && (
                <div className="space-y-2">
                  <span className="text-muted-foreground text-xs">
                    {t("warnings") || "Warnings"}
                  </span>
                  <ul className="space-y-1">
                    {confirmation.warnings.map((warning, i) => (
                      <li
                        key={i}
                        className={cn(
                          "flex items-start gap-2 rounded-md p-2 text-xs",
                          isHighRisk ? "bg-destructive/10" : "bg-yellow-500/10"
                        )}
                      >
                        <AlertTriangle
                          className={cn(
                            "mt-0.5 h-3 w-3 flex-shrink-0",
                            isHighRisk ? "text-destructive" : "text-yellow-500"
                          )}
                        />
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Admin requirement */}
              {confirmation.requires_admin && (
                <div className="bg-destructive/10 flex items-center gap-2 rounded-md p-2">
                  <ShieldAlert className="text-destructive h-4 w-4" />
                  <span className="text-xs">
                    {t("adminRequired") || "Administrator privileges required"}
                  </span>
                </div>
              )}

              {/* Confirmation checkbox for critical operations */}
              {isCritical && (
                <label className="flex cursor-pointer items-center gap-2 rounded-md border p-3">
                  <Checkbox
                    id="understand-risk"
                    checked={understood}
                    onCheckedChange={(checked) => setUnderstood(checked === true)}
                  />
                  <span className="text-xs">
                    {t("understandRisks") || "I understand the risks and confirm to proceed"}
                  </span>
                </label>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t("cancel") || "Cancel"}</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant={isHighRisk ? "destructive" : "default"}
              onClick={onConfirm}
              disabled={loading || (isCritical && !understood)}
            >
              {loading ? t("processing") || "Processing..." : t("confirm") || "Confirm"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface AdminElevationDialogProps {
  open: boolean
  onRequestElevation: () => void
  onCancel: () => void
  loading?: boolean
}

export function AdminElevationDialog({
  open,
  onRequestElevation,
  onCancel,
  loading = false,
}: AdminElevationDialogProps) {
  const t = useTranslations("scheduler")

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-orange-500" />
            {t("adminElevationTitle") || "Administrator Privileges Required"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>
                {t("adminElevationDesc") ||
                  "This operation requires administrator privileges. Please restart the application as administrator, or click the button below to request elevation."}
              </p>

              <div className="bg-muted space-y-2 rounded-lg p-3">
                <p className="text-xs font-medium">{t("platformWindows")}:</p>
                <p className="text-muted-foreground text-xs">{t("adminElevationWindows")}</p>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{t("cancel") || "Cancel"}</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button onClick={onRequestElevation} disabled={loading} variant="default">
              {loading
                ? t("requesting") || "Requesting..."
                : t("requestElevation") || "Request Elevation"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
