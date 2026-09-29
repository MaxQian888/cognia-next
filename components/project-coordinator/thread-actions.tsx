"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ThreadBoardState } from "@/lib/project-coordinator/thread-state"
import {
  reopenThread,
  resolveThread,
  startThread,
  stopThread,
  type StartThreadResult,
} from "@/lib/project-coordinator/thread-runtime"

/**
 * The per-thread controls shared by the board row and the chat card. Each
 * control appears only in the states where it means something.
 */

export interface ThreadActionsProps {
  threadId: string
  title: string
  state: ThreadBoardState
}

function startNotice(
  result: StartThreadResult,
  t: ReturnType<typeof useTranslations<"projectCoordinator.row">>
): string | undefined {
  switch (result.kind) {
    case "refuse":
      return t(`refused.${result.reason}`)
    case "stage":
      return t(`staged.${result.reason}`)
    case "pending-runtime":
      return t("starting")
    default:
      return undefined
  }
}

export function ThreadActions({ threadId, title, state }: ThreadActionsProps) {
  const t = useTranslations("projectCoordinator.row")
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<string | undefined>) => {
    if (busy) return
    setBusy(true)
    try {
      const notice = await action()
      if (notice) toast.info(notice)
    } catch (error) {
      toast.error(
        t("actionFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t("actions", { title })}
    >
      {state === "staged" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void run(async () => startNotice(await startThread(threadId, "user"), t))}
          data-testid={`thread-start-${threadId}`}
        >
          <PlayIcon aria-hidden className="size-3" />
          {t("start")}
        </Button>
      ) : null}
      {state === "working" || state === "waiting" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await stopThread(threadId)
              return undefined
            })
          }
          data-testid={`thread-stop-${threadId}`}
        >
          <SquareIcon aria-hidden className="size-3" />
          {t("stop")}
        </Button>
      ) : null}
      {state === "resolved" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await reopenThread(threadId)
              return undefined
            })
          }
          data-testid={`thread-reopen-${threadId}`}
        >
          <RotateCcwIcon aria-hidden className="size-3" />
          {t("reopen")}
        </Button>
      ) : state !== "working" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await resolveThread(threadId, "user")
              return undefined
            })
          }
          data-testid={`thread-resolve-${threadId}`}
        >
          <CheckIcon aria-hidden className="size-3" />
          {t("resolve")}
        </Button>
      ) : null}
    </div>
  )
}
