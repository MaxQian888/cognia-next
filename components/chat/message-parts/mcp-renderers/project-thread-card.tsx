"use client"

/**
 * The coordinator transcript's card for a thread it started or addressed
 * (`spawn_thread`, `start_thread`, `message_thread`, `stop_thread`,
 * `resolve_thread` — ADR-0204). It renders the thread LIVE, not the tool's
 * snapshot: the same row the project board shows, so the card and the board
 * can never disagree about a thread's state.
 */

import type { ToolUIPart } from "ai"
import { useNow, useTranslations } from "next-intl"
import { useClientLiveQuery } from "@/hooks/data"
import { getSession } from "@/lib/db/sessions"
import { useProjectThreadRows } from "@/hooks/project-coordinator/use-project-threads"
import { ProjectThreadRow } from "@/components/project-coordinator/thread-row"
import { useParsedOutput } from "./common"

interface ThreadToolOutput {
  ok?: boolean
  threadId?: string
}

export function ProjectThreadCard({ part }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("projectCoordinator.threadCard")
  const now = useNow({ updateInterval: 60_000 }).getTime()
  const output = useParsedOutput<ThreadToolOutput>(part.output)
  const threadId = output?.ok ? output.threadId : undefined
  const thread = useClientLiveQuery(
    async () => (threadId ? ((await getSession(threadId)) ?? null) : null),
    [threadId],
    null
  )
  const rows = useProjectThreadRows(thread ? [thread] : thread === null ? [] : undefined, now)
  if (!threadId) return null
  if (thread === null) {
    return (
      <p className="my-1 text-xs text-muted-foreground" data-testid="mcp-project-thread-missing">
        {t("missing")}
      </p>
    )
  }
  const row = rows?.[0]
  if (!row) return null
  return (
    <div className="my-1 rounded-control border" data-testid="mcp-project-thread-card">
      <ProjectThreadRow row={row} />
    </div>
  )
}
