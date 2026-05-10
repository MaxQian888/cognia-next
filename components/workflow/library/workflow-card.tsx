"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { deleteWorkflow, duplicateWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowCardProps {
  workflow: WorkflowRow
}

export function WorkflowCard({ workflow }: WorkflowCardProps) {
  const t = useTranslations("workflows.card")
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const triggerCount = workflow.nodes.filter((n) => n.type.startsWith("trigger.")).length
  const actionCount = workflow.nodes.filter((n) => n.type.startsWith("action.")).length

  const handleDelete = async () => {
    try {
      await deleteWorkflow(workflow.id)
      toast.success(t("deleted"))
      setConfirmDelete(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteFailed"))
    }
  }

  const handleDuplicate = async () => {
    try {
      const copy = await duplicateWorkflow(workflow.id)
      toast.success(t("duplicated"))
      router.push(`/workflows/${copy.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateFailed"))
    }
  }

  return (
    <>
      <Card className="group transition hover:border-primary/50 hover:shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <Link
            href={`/workflows/${workflow.id}`}
            className="flex items-start gap-3 flex-1 min-w-0"
          >
            <span className="rounded-md bg-primary/10 p-2 text-primary shrink-0">
              <WorkflowIcon className="size-5" aria-hidden="true" />
            </span>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-base truncate">{workflow.name}</CardTitle>
              {workflow.description ? (
                <CardDescription className="line-clamp-2 mt-1">
                  {workflow.description}
                </CardDescription>
              ) : null}
            </div>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t("edit")}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/workflows/${workflow.id}`}>
                  <PencilIcon className="size-4 mr-2" /> {t("edit")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/workflows/${workflow.id}/runs`}>
                  <PlayIcon className="size-4 mr-2" /> {t("viewRuns")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate}>
                <CopyIcon className="size-4 mr-2" /> {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={workflow.isBuiltIn}
              >
                <Trash2Icon className="size-4 mr-2" /> {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent className="pt-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            {t("node", { count: workflow.nodes.length })}
          </Badge>
          {triggerCount > 0 ? (
            <Badge variant="outline" className="font-normal">
              {t("trigger", { count: triggerCount })}
            </Badge>
          ) : null}
          {actionCount > 0 ? (
            <Badge variant="outline" className="font-normal">
              {t("action", { count: actionCount })}
            </Badge>
          ) : null}
          {workflow.isBuiltIn ? (
            <Badge variant="secondary" className="font-normal">
              {t("builtin")}
            </Badge>
          ) : null}
          {workflow.isTemplate ? (
            <Badge variant="secondary" className="font-normal">
              {t("template")}
            </Badge>
          ) : null}
          <span className="ml-auto">
            {t("updated", { ago: new Date(workflow.updatedAt).toLocaleDateString() })}
          </span>
        </CardContent>
      </Card>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirm.description", { name: workflow.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteConfirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("deleteConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
