"use client"

/**
 * The conversation's record of an independent review (ADR-0117
 * `verified-fresh-agent`).
 *
 * The card is deliberately plain: a verdict, the reviewer's own sentence, the
 * concrete points, and one way into the reviewer's session. The session is a
 * real, visible conversation, so "open" switches the pane to it exactly the
 * way an imported subagent's transcript is opened, and a session that is not
 * on this device says so instead of swapping to an empty pane.
 *
 * Nothing here is live-queried. The verdict is a one-shot answer that must
 * read the same after a reload, so the part carries it.
 */

import { memo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useChatStore } from "@/stores/chat/chat-store"
import type {
  VerificationVerdict,
  VerificationVerdictPart as VerificationVerdictPartType,
} from "@/lib/claude/parts-extensions"
import { cn } from "@/lib/utils"

interface Props {
  part: VerificationVerdictPartType
}

const VERDICT_ICON: Record<VerificationVerdict, LucideIcon> = {
  pass: CircleCheckIcon,
  fail: CircleXIcon,
  unsure: CircleHelpIcon,
}

const VERDICT_TONE: Record<VerificationVerdict, string> = {
  pass: "text-emerald-600 dark:text-emerald-500",
  fail: "text-destructive",
  unsure: "text-amber-600 dark:text-amber-500",
}

/**
 * Switch the pane to the reviewer's session, or explain that it is not here.
 * Mirrors `openNestedTranscript` in `subagent-part.tsx`: `setActiveSession`
 * on an id with no row shows an empty conversation that looks like a bug.
 */
async function openVerificationSession(sessionId: string, missingMessage: string): Promise<void> {
  const { getSession } = await import("@/lib/db/sessions")
  const exists = await getSession(sessionId).catch(() => undefined)
  if (!exists) {
    toast.error(missingMessage)
    return
  }
  useChatStore.getState().setActiveSession(sessionId)
}

export const VerificationVerdictPart = memo(function VerificationVerdictPart({ part }: Props) {
  const t = useTranslations("agentComposition.verification")
  const verdict = part.status === "completed" ? (part.verdict ?? "unsure") : null
  const Icon = verdict ? VERDICT_ICON[verdict] : null

  return (
    <Card
      className="not-prose my-2 space-y-2 p-3"
      data-testid="verification-verdict-part"
      data-status={part.status}
      data-verdict={verdict ?? undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldCheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{t("title")}</span>
        {part.status === "running" ? (
          <Badge
            variant="outline"
            className="flex shrink-0 items-center gap-1 text-[10px]"
            data-testid="verification-verdict-running"
          >
            <Spinner className="size-3" />
            {t("running")}
          </Badge>
        ) : null}
        {part.status === "failed" ? (
          <Badge
            variant="destructive"
            className="shrink-0 text-[10px]"
            data-testid="verification-verdict-failed"
          >
            {t("failed")}
          </Badge>
        ) : null}
        {verdict && Icon ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-xs font-medium",
              VERDICT_TONE[verdict]
            )}
            data-testid="verification-verdict-badge"
            role="status"
          >
            <Icon aria-hidden className="size-3.5" />
            {t(`verdict.${verdict}`)}
          </span>
        ) : null}
        {part.verificationSessionId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
            data-testid="verification-verdict-open"
            onClick={() =>
              void openVerificationSession(part.verificationSessionId, t("sessionMissing"))
            }
          >
            {t("openSession")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </Button>
        ) : null}
      </div>

      {part.status === "failed" && part.error ? (
        <p className="text-xs text-destructive" data-testid="verification-verdict-error">
          {part.error}
        </p>
      ) : null}

      {part.status === "completed" ? (
        <>
          {part.summary ? (
            <p className="text-xs" data-testid="verification-verdict-summary">
              {part.summary}
            </p>
          ) : null}
          {part.points.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">{t("points")}</p>
              <ul
                className="list-disc space-y-0.5 pl-4 text-xs"
                data-testid="verification-verdict-points"
              >
                {part.points.map((point, index) => (
                  <li key={`${index}:${point}`}>{point}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="verification-verdict-no-points"
            >
              {t("noPoints")}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {part.diffIncluded ? t("withDiff") : t("withoutDiff")}
          </p>
        </>
      ) : null}
    </Card>
  )
})

export default VerificationVerdictPart
