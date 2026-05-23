"use client"

/**
 * Generic confirm dialog for the agent-team workspace, layered on the shared
 * `AlertDialog` primitive. Centralises the workspace's destructive flows
 * (critical-escalation change, clear memory, delete team, force-resolve
 * consensus, remove teammate) so they share one widget with consistent
 * wording, an optional type-to-confirm guard, and a tone.
 *
 * Not a replacement for `components/a2ui/delete-confirm-dialog.tsx` (a2ui-
 * namespaced) or `components/scheduler/task-confirmation-dialog.tsx`
 * (scheduler-shaped) — those stay domain-bound. This one is workspace-scoped
 * and string-prop driven so callers pass already-translated copy.
 */

import { useState } from "react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  /** Visual tone of the confirm button. Defaults to "destructive". */
  tone?: "destructive" | "warning"
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact string. The label above the input is `typeToConfirmLabel`.
   */
  typeToConfirm?: string
  typeToConfirmLabel?: string
  typeToConfirmPlaceholder?: string
  onConfirm: () => void | Promise<void>
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "destructive",
  typeToConfirm,
  typeToConfirmLabel,
  typeToConfirmPlaceholder,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [typed, setTyped] = useState("")
  const confirmDisabled = typeToConfirm !== undefined && typed !== typeToConfirm

  const handleOpenChange = (next: boolean) => {
    if (!next) setTyped("")
    onOpenChange(next)
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {typeToConfirm !== undefined ? (
          <div className="space-y-1">
            {typeToConfirmLabel ? <Label className="text-xs">{typeToConfirmLabel}</Label> : null}
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={typeToConfirmPlaceholder ?? typeToConfirm}
              className="h-8 text-xs"
              data-testid="confirm-type-to-confirm"
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirmDisabled}
            className={cn(
              tone === "destructive" &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            )}
            onClick={() => {
              void onConfirm()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
