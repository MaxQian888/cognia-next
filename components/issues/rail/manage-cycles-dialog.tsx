"use client"

/**
 * The rail's way into the cycle editor: `CycleEditorList` inside a dialog.
 * The tracker's Cycles tab mounts the same editor as a page
 * (`components/issues/cycles/cycle-console.tsx`).
 */

import { useTranslations } from "next-intl"

import {
  CycleEditorList,
  type CycleEditorListProps,
} from "@/components/issues/cycles/cycle-editor-list"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface ManageCyclesDialogProps extends Pick<
  CycleEditorListProps,
  "projectId" | "cycles" | "projects" | "progress"
> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ManageCyclesDialog({
  open,
  onOpenChange,
  projectId,
  cycles,
  projects,
  progress,
}: ManageCyclesDialogProps) {
  const t = useTranslations("issues.cycles")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="manage-cycles-dialog">
        <DialogHeader>
          <DialogTitle>{t("manageTitle")}</DialogTitle>
        </DialogHeader>
        <CycleEditorList
          projectId={projectId}
          cycles={cycles}
          projects={projects}
          progress={progress}
          listClassName="max-h-[50vh] overflow-y-auto"
        />
      </DialogContent>
    </Dialog>
  )
}
