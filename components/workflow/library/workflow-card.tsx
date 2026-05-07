"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
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
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const triggerCount = workflow.nodes.filter((n) => n.type.startsWith("trigger.")).length
  const actionCount = workflow.nodes.filter((n) => n.type.startsWith("action.")).length

  const handleDelete = async () => {
    try {
      await deleteWorkflow(workflow.id)
      toast.success("Workflow deleted")
      setConfirmDelete(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const handleDuplicate = async () => {
    try {
      const copy = await duplicateWorkflow(workflow.id)
      toast.success("Workflow duplicated")
      router.push(`/workflows/${copy.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to duplicate")
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
                aria-label="Workflow actions"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/workflows/${workflow.id}`}>
                  <PencilIcon className="size-4 mr-2" /> Edit
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/workflows/${workflow.id}/runs`}>
                  <PlayIcon className="size-4 mr-2" /> View runs
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate}>
                <CopyIcon className="size-4 mr-2" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={workflow.isBuiltIn}
              >
                <Trash2Icon className="size-4 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent className="pt-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            {workflow.nodes.length} {workflow.nodes.length === 1 ? "node" : "nodes"}
          </Badge>
          {triggerCount > 0 ? (
            <Badge variant="outline" className="font-normal">
              {triggerCount} trigger{triggerCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
          {actionCount > 0 ? (
            <Badge variant="outline" className="font-normal">
              {actionCount} action{actionCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
          {workflow.isBuiltIn ? (
            <Badge variant="secondary" className="font-normal">
              Built-in
            </Badge>
          ) : null}
          {workflow.isTemplate ? (
            <Badge variant="secondary" className="font-normal">
              Template
            </Badge>
          ) : null}
          <span className="ml-auto">
            Updated {new Date(workflow.updatedAt).toLocaleDateString()}
          </span>
        </CardContent>
      </Card>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              {workflow.name} will be permanently removed. Run history is preserved but cannot be
              re-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
