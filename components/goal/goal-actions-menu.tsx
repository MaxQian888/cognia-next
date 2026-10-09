"use client"

/**
 * The ⋯ menu every goal row and the inspector share (ADR-0019): open the
 * conversation the goal runs in, open its details, run it again as a new goal,
 * copy the objective, and delete it.
 *
 * Delete used to exist on one surface only — a trash icon in History, always
 * visible on every row. It lives here now, behind the same confirmation,
 * reachable wherever a goal is. "Run again" opens New goal pre-filled with the
 * objective (a stopped or finished goal cannot be resumed; re-running it was a
 * retype). Failures surface as toasts, never as a menu that silently closes.
 *
 * Delete and Run again go where the loop runs: on a paired phone, delete is
 * `goal_delete` and the new goal is `goal_create` (`useGoalControls`,
 * `useGoalCreate`), so both show there too, for a device holding the
 * remote-control grant.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CopyIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"

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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { goalConversationHref } from "./goal-conversation-link"
import { GoalQuickCreateDialog } from "./goal-quick-create-dialog"

export interface GoalActionsMenuProps {
  goal: Pick<Goal, "id" | "sessionId" | "safeObjective" | "rawObjective" | "status" | "config">
  /** Offer "Open details" — rows do, the inspector (already the details) does not. */
  onOpenDetails?: () => void
  /** Called after the goal is deleted, so a selection pointing at it can clear. */
  onDeleted?: () => void
  /** The conversation is known to be gone; "Open conversation" is withheld. */
  conversationMissing?: boolean
  triggerClassName?: string
  align?: "start" | "end"
}

export function GoalActionsMenu({
  goal,
  onOpenDetails,
  onDeleted,
  conversationMissing = false,
  triggerClassName,
  align = "end",
}: GoalActionsMenuProps) {
  const t = useTranslations("goal")
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [rerunOpen, setRerunOpen] = useState(false)
  // Without the remote-control grant a paired phone can neither delete the
  // desktop's goal nor start a new one there.
  const controls = useGoalControls(goal)
  const deleting = controls.busy

  async function handleDelete() {
    // The hook confirms or reports; a failure keeps the dialog open to retry.
    if (!(await controls.deleteGoal())) return
    setConfirmDelete(false)
    onDeleted?.()
  }

  async function copyObjective() {
    try {
      await navigator.clipboard.writeText(goal.safeObjective)
      toast.success(t("actions.copied"))
    } catch {
      toast.error(t("actions.copyFailed"))
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-8 text-muted-foreground hover:text-foreground", triggerClassName)}
            aria-label={t("actions.menu")}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            data-testid={`goal-actions-${goal.id}`}
          >
            <MoreHorizontalIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          className="w-52"
          onClick={(event) => event.stopPropagation()}
        >
          {!conversationMissing ? (
            <DropdownMenuItem
              onSelect={() => router.push(goalConversationHref(goal.sessionId))}
              data-testid="goal-action-open-conversation"
            >
              <MessageSquareIcon aria-hidden />
              {t("actions.openConversation")}
            </DropdownMenuItem>
          ) : null}
          {onOpenDetails ? (
            <DropdownMenuItem onSelect={onOpenDetails} data-testid="goal-action-details">
              <PanelRightOpenIcon aria-hidden />
              {t("pill.details")}
            </DropdownMenuItem>
          ) : null}
          {controls.allowed ? (
            <DropdownMenuItem onSelect={() => setRerunOpen(true)} data-testid="goal-action-rerun">
              <RotateCcwIcon aria-hidden />
              {t("actions.runAgain")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => void copyObjective()} data-testid="goal-action-copy">
            <CopyIcon aria-hidden />
            {t("actions.copyObjective")}
          </DropdownMenuItem>
          {controls.allowed ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmDelete(true)}
                data-testid="goal-action-delete"
              >
                <Trash2Icon aria-hidden />
                {t("history.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(next) => !deleting && setConfirmDelete(next)}
      >
        <AlertDialogContent data-testid="goal-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("history.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("history.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="line-clamp-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
            {goal.safeObjective}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("history.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault()
                void handleDelete()
              }}
              data-testid="goal-delete-confirm"
            >
              {t("history.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mounted only while open: the dialog subscribes to sessions and
          templates, and a list renders one menu per row. */}
      {rerunOpen ? (
        <GoalQuickCreateDialog
          open
          onOpenChange={setRerunOpen}
          initialObjective={goal.rawObjective || goal.safeObjective}
          showTrigger={false}
        />
      ) : null}
    </>
  )
}

GoalActionsMenu.displayName = "GoalActionsMenu"
