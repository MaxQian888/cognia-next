"use client"

/**
 * A thread's pull-request state and the actions it allows (ADR-0204): an
 * instruction to the thread (fix CI, address comments, resolve conflicts),
 * opening the PR, merging it after a confirm, or publishing the branch.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ExternalLinkIcon, GitMergeIcon, GitPullRequestIcon, WrenchIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"
import {
  availablePrActions,
  createThreadPr,
  mergeThreadPr,
  type ThreadPrInstruction,
} from "@/lib/project-coordinator/pr-actions"
import { sendToThread } from "@/lib/project-coordinator/thread-runtime"

export interface ThreadPrActionsProps {
  thread: ChatSession
  pr?: PrDerivedStatus
}

const INSTRUCTION_LABEL: Record<
  ThreadPrInstruction,
  "fixCi" | "addressComments" | "resolveConflicts"
> = {
  "fix-ci": "fixCi",
  "address-comments": "addressComments",
  "resolve-conflicts": "resolveConflicts",
}

export function ThreadPrActions({ thread, pr }: ThreadPrActionsProps) {
  const t = useTranslations("projectCoordinator.pr")
  const [busy, setBusy] = useState(false)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const actions = availablePrActions(thread, pr)
  const url = thread.projectThread?.prRef?.url
  if (actions.length === 0 && !pr) return null

  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  const instruct = (instruction: ThreadPrInstruction) =>
    run(async () => {
      if (!(await sendToThread(thread.id, t(`instruction.${instruction}`)))) {
        toast.error(t("sendFailed"))
      }
    })

  const create = () =>
    run(async () => {
      try {
        await createThreadPr(thread)
        toast.success(t("created"))
      } catch (error) {
        toast.error(
          t("createFailed", { error: error instanceof Error ? error.message : String(error) })
        )
      }
    })

  const merge = () =>
    run(async () => {
      try {
        await mergeThreadPr(thread)
        toast.success(t("merged"))
      } catch (error) {
        toast.error(
          t("mergeFailed", { error: error instanceof Error ? error.message : String(error) })
        )
      }
    })

  return (
    <div className="flex shrink-0 items-center gap-1" data-testid={`thread-pr-${thread.id}`}>
      {pr && pr !== "none" ? (
        <Badge variant="outline" className="text-[10px]" data-testid={`thread-pr-status-${pr}`}>
          <GitPullRequestIcon aria-hidden className="size-3" />
          {t(`status.${pr}`)}
        </Badge>
      ) : null}
      {actions.map((action) => {
        switch (action) {
          case "fix-ci":
          case "address-comments":
          case "resolve-conflicts":
            return (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void instruct(action)}
                data-testid={`thread-pr-${action}-${thread.id}`}
              >
                <WrenchIcon aria-hidden className="size-3" />
                {t(INSTRUCTION_LABEL[action])}
              </Button>
            )
          case "merge":
            return (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmMerge(true)}
                data-testid={`thread-pr-merge-${thread.id}`}
              >
                <GitMergeIcon aria-hidden className="size-3" />
                {t("merge")}
              </Button>
            )
          case "review":
            return url ? (
              <Button key={action} size="xs" variant="ghost" asChild>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`thread-pr-review-${thread.id}`}
                >
                  <ExternalLinkIcon aria-hidden className="size-3" />
                  {t("review")}
                </a>
              </Button>
            ) : null
          case "create":
            return (
              <Button
                key={action}
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void create()}
                data-testid={`thread-pr-create-${thread.id}`}
              >
                <GitPullRequestIcon aria-hidden className="size-3" />
                {t("create")}
              </Button>
            )
        }
      })}
      <ConfirmActionDialog
        open={confirmMerge}
        onOpenChange={setConfirmMerge}
        title={t("mergeConfirmTitle")}
        description={t("mergeConfirmBody", { title: thread.title })}
        confirmLabel={t("merge")}
        cancelLabel={t("mergeCancel")}
        tone="warning"
        onConfirm={async () => {
          setConfirmMerge(false)
          await merge()
        }}
      />
    </div>
  )
}
