"use client"

/**
 * The "Session insights" sheet: wires {@link useSessionReport} to the
 * {@link SessionReportView}, with loading + empty states. Opened from the chat
 * header's insights action.
 *
 * It also owns the two things the pure view cannot: the conversation's cost
 * rank among the user's recent ones ({@link useSessionCostRank}), and the jump
 * from a pricey turn back into the transcript. The jump closes the sheet first,
 * because the row it scrolls to sits underneath it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSessionReport } from "@/hooks/analysis/use-session-report"
import { useSessionCostRank } from "@/hooks/usage/use-session-cost-rank"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import { SessionReportView } from "@/components/chat/session-insights/session-report-view"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  /** Only the identity is read, so any host's session shape can open the sheet. */
  session: Pick<ChatSession, "id" | "title">
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SessionInsightsSheet({ session, open, onOpenChange }: Props) {
  const t = useTranslations("sessionInsights")
  // Only analyze while the sheet is open — avoids running the live queries for
  // every session in the background.
  const { report, loading } = useSessionReport(open ? session.id : null, { title: session.title })
  // The rank's day window only needs a clock anchor, not a live one: the sheet
  // is a short-lived look, and an anchor taken on mount keeps render pure.
  const [openedAt] = useState(() => Date.now())

  // The session's whole history, so a conversation older than the peer window
  // is ranked on everything it cost rather than on its recent turns.
  const target = useMemo<SessionUsageSummary | null>(() => {
    if (!open || !report || report.turns === 0) return null
    return {
      sessionId: session.id,
      turns: report.turns,
      tokens: report.totalInputTokens + report.totalOutputTokens + report.totalCacheReadTokens,
      inputTokens: report.totalInputTokens,
      outputTokens: report.totalOutputTokens,
      costUsd: report.totalCostUsd,
      unpricedTurns: report.unpricedTurns,
    }
  }, [open, report, session.id])
  const rank = useSessionCostRank(target, openedAt)

  const jumpTo = (messageId: string) => {
    onOpenChange(false)
    void jumpToSessionMessage(session.id, messageId).then((landed) => {
      if (!landed) toast.error(t("costTimeline.jumpFailed"))
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{session.title}</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground" data-testid="insights-loading">
              {t("loading")}
            </p>
          ) : !report || report.turns === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="insights-empty">
              {t("empty")}
            </p>
          ) : (
            <SessionReportView
              report={report}
              sessionId={session.id}
              rank={rank}
              onJumpToMessage={jumpTo}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
