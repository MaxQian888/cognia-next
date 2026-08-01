"use client"

/**
 * Deleting a skill, and deciding what happens to its recordings.
 *
 * Two decisions, not one. Removing a skill made by the recorder does not imply
 * discarding the capture it came from — a user may well want to keep the source
 * and make another skill from it — and destroying the only copy of a recording
 * is not something to infer from a click on "Delete".
 *
 * So the extra checkbox appears only when there is a recording behind the skill,
 * and it defaults to **off**: the destructive half is opt-in.
 */

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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

interface Props {
  open: boolean
  skillName: string
  /** How many recorded source versions this skill has. */
  recordingCount?: number
  onCancel: () => void
  onConfirm: (options: { deleteRecordings: boolean }) => void
}

export function SkillDeleteDialog({
  open,
  skillName,
  recordingCount = 0,
  onCancel,
  onConfirm,
}: Props) {
  const t = useTranslations("skills.delete")
  const [deleteRecordings, setDeleteRecordings] = useState(false)

  // Never carried between dialogs: a checkbox someone ticked for one skill must
  // not silently destroy the next skill's recordings. Adjusted during render
  // rather than in an effect — an effect would let one frame of the reopened
  // dialog paint with the previous skill's answer still ticked.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setDeleteRecordings(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body", { name: skillName })}</AlertDialogDescription>
        </AlertDialogHeader>
        {recordingCount > 0 ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id="skill-delete-recordings"
                checked={deleteRecordings}
                onCheckedChange={(checked) => setDeleteRecordings(checked === true)}
              />
              <Label htmlFor="skill-delete-recordings" className="text-sm font-normal">
                {t("bundles.label", { count: recordingCount })}
              </Label>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">{t("bundles.hint")}</p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm({ deleteRecordings })}>
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
