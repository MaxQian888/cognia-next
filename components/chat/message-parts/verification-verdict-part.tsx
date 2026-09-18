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

import { memo, useState } from "react"
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
import { Spinner } from "@/components/ui/spinner"
import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
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

const VERDICT_DOT: Record<VerificationVerdict, ToolDotStatus> = {
  pass: "complete",
  fail: "error",
  unsure: "warning",
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
  // The review's content IS the message — settled verdicts (and failures)
  // open by default so the points/error read without a click; only the
  // in-flight "running" placeholder stays collapsed.
  const [open, setOpen] = useState(part.status !== "running")
  const verdict = part.status === "completed" ? (part.verdict ?? "unsure") : null
  const Icon = verdict ? VERDICT_ICON[verdict] : null
  const dot: ToolDotStatus =
    part.status === "running"
      ? "running"
      : part.status === "failed"
        ? "error"
        : verdict
          ? VERDICT_DOT[verdict]
          : "pending"

  return (
    // Shared row chrome: dot carries the run/verdict status, the verdict lands
    // in the meta slot, "open session" is a hover action, and the reviewer's
    // summary + points expand under the left rule.
    <div
      className="my-2"
      data-testid="verification-verdict-part"
      data-status={part.status}
      data-verdict={verdict ?? undefined}
    >
      <ToolRowShell
        status={dot}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel={t("title")}
        testId="verification-verdict-row"
        lead={<span className="shrink-0 text-xs font-medium text-foreground/80">{t("title")}</span>}
        icon={<ShieldCheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        target={
          part.status === "completed" && part.summary ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {part.summary}
            </span>
          ) : (
            <span className="flex-1" />
          )
        }
        meta={
          <>
            {part.status === "running" ? (
              <span
                className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                data-testid="verification-verdict-running"
              >
                <Spinner className="size-3" />
                {t("running")}
              </span>
            ) : null}
            {part.status === "failed" ? (
              <span
                className="shrink-0 text-[10px] font-medium text-destructive"
                data-testid="verification-verdict-failed"
              >
                {t("failed")}
              </span>
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
          </>
        }
        actions={
          part.verificationSessionId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              aria-label={t("openSession")}
              title={t("openSession")}
              data-testid="verification-verdict-open"
              onClick={(e) => {
                e.stopPropagation()
                void openVerificationSession(part.verificationSessionId, t("sessionMissing"))
              }}
            >
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Button>
          ) : undefined
        }
      >
        <div className="mb-1 space-y-2 border-l pl-3 pt-1">
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
        </div>
      </ToolRowShell>
    </div>
  )
})

export default VerificationVerdictPart
