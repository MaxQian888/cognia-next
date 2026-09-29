"use client"

/**
 * `propose_threads` (ADR-0204): the coordinator's proposals, each with a Start
 * button — the user's click is the go-ahead the project's propose-first
 * preference asks for. Starting goes through the same admission as any
 * thread; the hard limits (paused, daily cap) still refuse.
 */

import { useState } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CheckIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { getSession } from "@/lib/db/sessions"
import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import { startProposedThread } from "@/lib/project-coordinator/user-actions"
import { useParsedOutput } from "./common"

type Proposal = SpawnedTaskBrief & { rootId?: string }

interface ProposeOutput {
  ok?: boolean
  proposals?: Proposal[]
}

export function SuggestedThreadsCard({
  part,
  sessionId,
}: {
  part: ToolUIPart
  sessionId?: string
}) {
  const t = useTranslations("projectCoordinator.suggested")
  const tRow = useTranslations("projectCoordinator.row")
  const output = useParsedOutput<ProposeOutput>(part.output)
  const coordinator = useClientLiveQuery(
    async () => (sessionId ? ((await getSession(sessionId)) ?? null) : null),
    [sessionId],
    null
  )
  // Keyed by position: a proposal has no id until it becomes a thread.
  const [started, setStarted] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const proposals = output?.ok ? (output.proposals ?? []) : []
  if (proposals.length === 0) return null
  const projectId = coordinator?.projectId
  const ready = Boolean(projectId && coordinator?.projectRole === "coordinator")

  const start = async (indexes: number[]) => {
    if (!ready || !projectId || !sessionId || busy) return
    setBusy(true)
    try {
      for (const index of indexes) {
        const { rootId, ...brief } = proposals[index]
        const result = await startProposedThread({
          projectId,
          coordinatorSessionId: sessionId,
          brief,
          ...(rootId ? { rootId } : {}),
        })
        if (result.kind === "refused") {
          toast.info(tRow(`refused.${result.reason}`))
          break
        }
        setStarted((prev) => ({ ...prev, [index]: true }))
      }
    } catch (error) {
      toast.error(
        tRow("actionFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy(false)
    }
  }

  const pending = proposals.map((_, index) => index).filter((index) => !started[index])

  return (
    <div className="my-1 space-y-1.5 text-xs" data-testid="mcp-suggested-threads-card">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t("title")}</span>
        {pending.length > 1 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!ready || busy}
            onClick={() => void start(pending)}
            data-testid="suggested-threads-start-all"
          >
            <PlayIcon aria-hidden className="size-3" />
            {t("startAll")}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1">
        {proposals.map((proposal, index) => (
          <li
            key={`${index}-${proposal.title}`}
            className="flex items-start gap-2 rounded-control border px-2 py-1.5"
            data-testid={`suggested-thread-${index}`}
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{proposal.title}</div>
              <p className="text-muted-foreground">{proposal.tldr}</p>
            </div>
            {started[index] ? (
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                <CheckIcon aria-hidden className="size-3" />
                {t("started")}
              </span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={!ready || busy}
                onClick={() => void start([index])}
                data-testid={`suggested-thread-start-${index}`}
              >
                <PlayIcon aria-hidden className="size-3" />
                {t("start")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
