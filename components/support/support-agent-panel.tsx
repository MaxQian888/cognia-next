"use client"

/**
 * Compact Support Agent strip, pinned above the composer while the built-in
 * Support character is active.
 *
 * One row: identity · diagnostics-consent chip (popover with the kill switch
 * and its redacted preview) · "Report a problem". The report dialog receives
 * the live conversation as a redacted, toggleable section and offers every
 * report channel, so the strip itself carries no bare issue link.
 */

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { BugIcon, LifeBuoyIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useSupportDiagnosticsConsent } from "@/hooks/support/use-support-diagnostics-consent"
import { buildSupportConversationSummary } from "@/lib/support-agent/conversation-draft"
import type { SupportReportContext } from "@/lib/support-report/types"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { cn } from "@/lib/utils"
import { useSessionMessages } from "@/stores/chat"

import { ReportProblemDialog } from "./report-problem-dialog"
import { SupportDiagnosticsConsent } from "./support-diagnostics-consent"

export function SupportAgentPanel({ sessionId }: { sessionId: string | null }) {
  const t = useTranslations("support.panel")
  const messages = useSessionMessages(sessionId)
  const { enabled: diagnosticsEnabled } = useSupportDiagnosticsConsent("chat")
  const conversationSummary = useMemo(
    () =>
      buildSupportConversationSummary(messages, {
        user: t("userReport"),
        support: t("supportResponse"),
      }),
    [messages, t]
  )
  const reportContext = useMemo<Omit<SupportReportContext, "description">>(
    () => ({
      surface: "chat",
      ...(sessionId ? { sessionId } : {}),
      ...(conversationSummary ? { conversationSummary } : {}),
    }),
    [sessionId, conversationSummary]
  )

  useEffect(() => {
    if (sessionId) void trackEvent("support.session.opened", { sessionId })
  }, [sessionId])

  return (
    <div
      className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs"
      data-testid="support-agent-panel"
    >
      <LifeBuoyIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate font-medium">{t("title")}</span>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 gap-1.5 rounded-full border px-2 text-[11px] font-normal",
              diagnosticsEnabled
                ? "border-success/40 bg-success/10 text-success hover:bg-success/15"
                : "border-border text-muted-foreground"
            )}
            aria-label={t("diagnosticsChipAria")}
            data-testid="support-diagnostics-chip"
          >
            {diagnosticsEnabled ? (
              <ShieldCheckIcon className="size-3" aria-hidden="true" />
            ) : (
              <ShieldOffIcon className="size-3" aria-hidden="true" />
            )}
            {diagnosticsEnabled ? t("diagnosticsOn") : t("diagnosticsOff")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
          <SupportDiagnosticsConsent surface="chat" />
        </PopoverContent>
      </Popover>

      <div className="ml-auto flex items-center gap-1">
        <ReportProblemDialog
          context={reportContext}
          trigger={
            <Button type="button" variant="secondary" size="sm" className="h-7 gap-1.5 text-xs">
              <BugIcon className="size-3.5" aria-hidden="true" />
              {t("reportProblem")}
            </Button>
          }
        />
      </div>
    </div>
  )
}
