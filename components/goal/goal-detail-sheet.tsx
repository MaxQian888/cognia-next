"use client"

/**
 * A goal's detail surface as an overlay (ADR-0019): a right-side Sheet on
 * desktop, a bottom Drawer on a phone (`ResponsiveDetailSheet`). Used where
 * the goal is not the page's subject — the composer's goal pill — and by the
 * Goals console below the width where its inspector sits beside the list.
 *
 * The body is `GoalDetailPanel`, the same component the console's inspector
 * pane renders, which reads the goal live by id and draws its own header
 * (status, objective, facts, controls, close). The sheet keeps its title and
 * description for assistive tech only, so nothing is printed twice.
 */

import { useTranslations } from "next-intl"

import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import type { Goal } from "@/types/goal"

import { GoalDetailPanel } from "./goal-detail-panel"

interface Props {
  goal: Goal
  open: boolean
  onOpenChange: (next: boolean) => void
  /** The goal was deleted from the sheet. Defaults to closing it. */
  onDeleted?: () => void
}

export function GoalDetailSheet({ goal, open, onOpenChange, onDeleted }: Props) {
  const t = useTranslations("goal")
  const title = t("detailSheet.title", { status: t(`status.${goal.status}`) })

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={goal.safeObjective}
      headerVisuallyHidden
      showCloseButton={false}
      contentClassName="gap-0 p-0 sm:max-w-xl"
    >
      <GoalDetailPanel
        goalId={goal.id}
        initialGoal={goal}
        onClose={() => onOpenChange(false)}
        onDeleted={onDeleted ?? (() => onOpenChange(false))}
        className="min-h-0 flex-1"
      />
    </ResponsiveDetailSheet>
  )
}
