"use client"

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ISSUES_URL } from "@/lib/constants/external-urls"
import { buildSupportConversationSummary } from "@/lib/support-agent/conversation-draft"
import { useSessionMessages } from "@/stores/chat"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { SupportAgentControls } from "./support-agent-controls"
import { SupportFeedbackDialog } from "./support-feedback-dialog"

export function SupportAgentPanel({ sessionId }: { sessionId: string | null }) {
  const t = useTranslations("settings.characters.support")
  const messages = useSessionMessages(sessionId)
  const initialSummary = useMemo(
    () =>
      buildSupportConversationSummary(messages, {
        user: t("userReport"),
        support: t("supportResponse"),
      }),
    [messages, t]
  )

  useEffect(() => {
    if (sessionId) void trackEvent("support.session.opened", { sessionId })
  }, [sessionId])

  return (
    <aside
      className="mx-3 mb-2 grid gap-2 rounded-lg border bg-muted/10 p-2 sm:grid-cols-[minmax(0,1fr)_auto]"
      data-testid="support-agent-panel"
    >
      <SupportAgentControls surface="chat" />
      <div className="flex flex-col gap-2 sm:w-52">
        <SupportFeedbackDialog
          initialSummary={initialSummary}
          sessionId={sessionId ?? undefined}
          surface="chat"
        />
        <Button variant="ghost" size="sm" asChild>
          <a href={`${ISSUES_URL}/new`} target="_blank" rel="noreferrer">
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
            {t("openIssue")}
          </a>
        </Button>
      </div>
    </aside>
  )
}
