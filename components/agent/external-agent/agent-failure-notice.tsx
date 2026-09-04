"use client"

/**
 * The last thing that failed for ONE agent, drawn on that agent.
 *
 * Replaces a single dismissible banner above the whole list. That banner could
 * not say which agent it was about, it sat far from the control the user had
 * just pressed, and Dismiss was the only way to change its state, so the one
 * record of a failed connection was gone after a click and a retry that failed
 * the same way looked like it had done nothing at all.
 *
 * The causes matter as much as the message. A connect failure is usually a
 * wrapper around the sentence that explains it, and the wrapper alone is the
 * difference between "could not connect" and "could not determine the Pi
 * version".
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Copy, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { failureLines, type ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"

export interface AgentFailureNoticeProps {
  failure: ExternalAgentFailure
  /** Runs the failed action again. Omitted where retrying makes no sense. */
  onRetry?: () => void
  onDismiss: () => void
  /** True while the retry is in flight, so the button cannot be double-fired. */
  retrying?: boolean
  className?: string
}

export function AgentFailureNotice({
  failure,
  onRetry,
  onDismiss,
  retrying = false,
  className,
}: AgentFailureNoticeProps) {
  const t = useTranslations("externalAgent.failure")
  const tCommon = useTranslations("common")
  // Keyed by the report, not a bare boolean: the same notice is reused for
  // whatever failed most recently, so a confirmation left over from the
  // previous report would claim the new one had been copied.
  const [copiedAt, setCopiedAt] = useState<number | null>(null)
  const copied = copiedAt === failure.at
  // Memoized on the failure so the callback below has something stable to
  // depend on. Recomputing per render handed `useCallback` a new array every
  // time, which made the memo a no-op with extra steps.
  const lines = useMemo(() => failureLines(failure), [failure])
  const [headline, ...causes] = lines

  const stamp = failure.at
  const handleCopy = useCallback(() => {
    // Guarded rather than assumed: the clipboard API is absent over plain HTTP
    // on a LAN address, which is exactly how a paired browser reaches a Host.
    const text = lines.join("\n")
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopiedAt(stamp))
      .catch(() => setCopiedAt(null))
  }, [lines, stamp])

  return (
    <Surface
      layer="raised"
      radius="control"
      role="alert"
      data-testid={`agent-failure-${failure.agentId}`}
      className={cn("mt-2 border border-destructive/30 bg-destructive/5 px-2.5 py-2", className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-destructive">{t(failure.phase)}</p>
          <p className="mt-0.5 text-[11px] break-words text-foreground/80">{headline}</p>
          {causes.length > 0 && (
            <div className="mt-1.5">
              <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                {t("causes")}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {causes.map((cause, index) => (
                  <li
                    key={`${index}-${cause}`}
                    className="text-[11px] break-words text-muted-foreground"
                  >
                    {cause}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={(event) => {
            event.stopPropagation()
            handleCopy()
          }}
        >
          <Copy className="mr-1 size-3" />
          {copied ? t("copied") : t("copy")}
        </Button>
        {onRetry && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={retrying}
            onClick={(event) => {
              event.stopPropagation()
              onRetry()
            }}
          >
            <RotateCw className={cn("mr-1 size-3", retrying && "animate-spin")} />
            {retrying ? t("retrying") : t("retry")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={(event) => {
            event.stopPropagation()
            onDismiss()
          }}
        >
          {tCommon("dismiss")}
        </Button>
      </div>
    </Surface>
  )
}
