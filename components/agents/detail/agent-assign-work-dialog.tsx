"use client"

/**
 * "Assign work" (ADR-0220): hand the agent a durable task, scheduled or to run
 * now, through the same form its task board uses. Issues are assigned from the
 * issue tracker, which the dialog points to.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { Character } from "@cognia/agent-config-types"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AgentTaskCreateForm } from "@/components/agent/agent-task-board"

export interface AgentAssignWorkDialogProps {
  agent: Pick<Character, "id" | "name">
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After a task is created. */
  onAssigned?: () => void
}

export function AgentAssignWorkDialog({
  agent,
  open,
  onOpenChange,
  onAssigned,
}: AgentAssignWorkDialogProps) {
  const t = useTranslations("agentsConsole.assign")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title", { name: agent.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <AgentTaskCreateForm
          agentId={agent.id}
          className="border-0 p-0"
          onCreated={(task) => {
            toast.success(t("assigned", { title: task.title }))
            onOpenChange(false)
            onAssigned?.()
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("issueHint")}{" "}
          <Link href="/issues" className="text-primary underline-offset-2 hover:underline">
            {t("openIssues")}
          </Link>
        </p>
      </DialogContent>
    </Dialog>
  )
}
