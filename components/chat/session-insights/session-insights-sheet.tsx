"use client"

/**
 * The "Session insights" sheet: wires {@link useSessionReport} to the
 * {@link SessionReportView}, with loading + empty states. Opened from the chat
 * header's insights action.
 */

import { useTranslations } from "next-intl"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useSessionReport } from "@/hooks/analysis/use-session-report"
import { SessionReportView } from "@/components/chat/session-insights/session-report-view"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SessionInsightsSheet({ session, open, onOpenChange }: Props) {
  const t = useTranslations("sessionInsights")
  // Only analyze while the sheet is open — avoids running the live queries for
  // every session in the background.
  const { report, loading } = useSessionReport(open ? session.id : null, { title: session.title })

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
            <SessionReportView report={report} sessionId={session.id} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
