"use client"

/**
 * What `/pair` shows instead of "Pairing failed / Failed to fetch".
 *
 * Three tiers, in the order a stuck user needs them:
 *
 *   1. **A named cause.** The kind's own headline, not the generic
 *      "Pairing failed" the flow used for every one of fourteen distinct
 *      failures.
 *   2. **What to do.** An ordered remedy list from {@link PairFailure.remedies},
 *      interpolated with *this* Host URL and *this* tab's origin so the user can
 *      copy the exact string the allowlist wants rather than guess it.
 *   3. **The technical detail**, collapsed. Kept verbatim — the raw
 *      `Failed to fetch` still belongs in a bug report, just not as the whole
 *      message — and copyable as one block.
 *
 * The invitation-spent banner is the part that matters most and is easiest to
 * miss: `cgnp3` invitations are one-shot, so for half these failures pressing
 * Submit again cannot work, and the UI has to say so instead of offering a
 * Retry button that silently burns another one.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { cn } from "@/lib/utils"

import { formatPairDiagnostics, pairFailureBodyKey, type PairFailure } from "./pair-failure"

export interface PairFailurePanelProps {
  failure: PairFailure
  /** Re-submit the same invitation. Only rendered when it can possibly work. */
  onRetry?: () => void
  /** Clear the field so the user can paste a freshly issued invitation. */
  onStartOver?: () => void
  /** Extra affordance owned by the caller (e.g. "Open Settings" for camera). */
  action?: { label: string; onAction: () => void | Promise<void> }
  className?: string
}

export function PairFailurePanel({
  failure,
  onRetry,
  onStartOver,
  action,
  className,
}: PairFailurePanelProps) {
  const t = useTranslations("mobile.pair")
  const [copied, setCopied] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  const onCopy = useCallback(async () => {
    try {
      await writeClipboardText(formatPairDiagnostics(failure))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [failure])

  const bodyValues = {
    message: failure.detail,
    status: failure.status ?? 0,
    got: failure.payloadVersion ?? 0,
    origin: failure.origin ?? "",
    host: failure.baseUrl ?? "",
  }

  return (
    <div
      role="alert"
      data-testid="pair-error"
      data-kind={failure.kind}
      data-stage={failure.stage}
      className={cn(
        "rounded-xl border border-destructive/35 bg-destructive/5 p-4 text-sm",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive" data-testid="pair-error-title">
            {t(`failure.title.${failure.kind}`)}
          </p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {failure.bodyText ?? t(pairFailureBodyKey(failure), bodyValues)}
          </p>
        </div>
      </div>

      {failure.invitationSpent ? (
        <p
          className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
          data-testid="pair-invitation-spent"
        >
          <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t("failure.invitationSpent")}
        </p>
      ) : null}

      {failure.remedies.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium">{t("failure.whatToDo")}</p>
          <ol
            className="mt-1.5 flex list-none flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground"
            data-testid="pair-error-remedies"
          >
            {failure.remedies.map((remedy, index) => (
              <li key={remedy} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground"
                >
                  {index + 1}
                </span>
                <span className="min-w-0">
                  {t(`failure.remedy.${remedy}`, {
                    origin: failure.origin ?? "",
                    host: failure.baseUrl ?? "",
                    loopback: failure.loopbackUrl ?? "",
                  })}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {action ? (
          <Button type="button" size="sm" variant="outline" onClick={action.onAction}>
            {action.label}
          </Button>
        ) : null}
        {failure.retryable && onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            data-testid="pair-error-retry"
          >
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            {t("failure.retry")}
          </Button>
        ) : null}
        {onStartOver ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onStartOver}
            data-testid="pair-error-start-over"
          >
            {t("failure.startOver")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void onCopy()}
          data-testid="pair-error-copy"
        >
          {copied ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ClipboardCopyIcon className="size-3.5" aria-hidden="true" />
          )}
          {copied ? t("failure.diagnosticsCopied") : t("failure.copyDiagnostics")}
        </Button>
      </div>

      <Collapsible open={detailOpen} onOpenChange={setDetailOpen} className="mt-2">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            data-testid="pair-error-detail-toggle"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", detailOpen && "rotate-180")}
              aria-hidden="true"
            />
            {t("failure.technicalDetail")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre
            className="mt-1.5 max-h-40 overflow-auto rounded-md border bg-background p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
            data-testid="pair-error-detail"
          >
            {formatPairDiagnostics(failure)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
