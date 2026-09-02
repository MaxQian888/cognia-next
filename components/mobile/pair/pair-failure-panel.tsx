"use client"

/**
 * What `/pair` shows instead of "Pairing failed / Failed to fetch".
 *
 * # One cause, one instruction, one button
 *
 * The taxonomy behind this panel is good — fourteen named kinds, each with an
 * ordered remedy list interpolated with *this* Host URL and *this* tab's
 * origin. The presentation was not: it rendered a headline, a paragraph, an
 * amber banner, a numbered remedy list, four buttons and a disclosure trigger,
 * all expanded, all at once. On the web flow that block was taller than the
 * form it belonged to, and a person who is already stuck reads none of it.
 *
 * So the panel now shows the three things a stuck user needs *first* — what
 * went wrong, the single next thing to do, and one button that does it — and
 * puts the remaining remedies, the diagnostics and the raw technical detail
 * behind one disclosure. Nothing was deleted; the order is now the order the
 * information is useful in.
 *
 * # The spent invitation is structural, not a banner
 *
 * `cgnp3` invitations are one-shot, so for half of these failures pressing
 * Submit again cannot work. That used to be an amber banner competing with
 * everything else for attention. It is now enforced by the shape of the panel:
 * a spent failure is diagnosed `retryable: false`, so no Retry button is
 * rendered at all and the primary action becomes "paste a new invitation". The
 * chip stays as the *explanation* for why Retry is absent — never as the only
 * thing standing between the user and a second burned invitation.
 */

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
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
  const [moreOpen, setMoreOpen] = useState(false)

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
    expected: (failure.expectedFingerprint ?? "").slice(0, 12),
    reported: (failure.reportedFingerprint ?? "").slice(0, 12),
  }
  const remedyValues = {
    origin: failure.origin ?? "",
    host: failure.baseUrl ?? "",
    loopback: failure.loopbackUrl ?? "",
  }

  const [nextStep, ...restRemedies] = failure.remedies

  // The one button, chosen in the order the fixes actually apply: a concrete
  // affordance the caller owns beats a generic retry, and a retry is only ever
  // offered when the diagnosis says the same invitation can still be spent.
  const canRetry = failure.retryable && onRetry !== undefined
  const primary: { label: string; onAction: () => void | Promise<void>; icon: ReactNode } | null =
    action
      ? { label: action.label, onAction: action.onAction, icon: null }
      : canRetry && onRetry
        ? {
            label: t("failure.retry"),
            onAction: onRetry,
            icon: <RefreshCwIcon className="size-3.5" aria-hidden="true" />,
          }
        : onStartOver
          ? { label: t("failure.startOver"), onAction: onStartOver, icon: null }
          : null

  // Anything the primary button did not already cover.
  const hasMore =
    restRemedies.length > 0 || (canRetry && !!onStartOver) || (!!action && (canRetry || !!onStartOver))

  return (
    <div
      role="alert"
      data-testid="pair-error"
      data-kind={failure.kind}
      data-stage={failure.stage}
      className={cn("rounded-xl border border-destructive/35 bg-destructive/5 p-4 text-sm", className)}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive" data-testid="pair-error-title">
            {t(`failure.title.${failure.kind}`)}
          </p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {failure.bodyText ?? t(pairFailureBodyKey(failure), bodyValues)}
          </p>
        </div>
      </div>

      {/* The single next thing to do. Promoted out of the numbered list because
          a list of five instructions has no first item the eye can find. */}
      {nextStep ? (
        <p
          className="rounded-control mt-3 flex items-start gap-2 bg-background/70 px-3 py-2 text-xs leading-relaxed"
          data-testid="pair-error-next-step"
        >
          <ArrowRightIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">{t(`failure.remedy.${nextStep}`, remedyValues)}</span>
        </p>
      ) : null}

      {failure.invitationSpent ? (
        <p
          className="mt-2 flex items-start gap-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
          data-testid="pair-invitation-spent"
        >
          <KeyRoundIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {t("failure.invitationSpent")}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {primary ? (
          <Button
            type="button"
            size="sm"
            onClick={primary.onAction}
            data-testid={
              action
                ? "pair-error-action"
                : canRetry
                  ? "pair-error-retry"
                  : "pair-error-start-over"
            }
          >
            {primary.icon}
            {primary.label}
          </Button>
        ) : null}
        {hasMore ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setMoreOpen((open) => !open)}
            aria-expanded={moreOpen}
            aria-controls="pair-error-more"
            data-testid="pair-error-more-toggle"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", moreOpen && "rotate-180")}
              aria-hidden="true"
            />
            {t("failure.moreOptions")}
          </Button>
        ) : null}
      </div>

      <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
        <CollapsibleContent id="pair-error-more">
          {restRemedies.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium">{t("failure.whatToDo")}</p>
              <ol
                className="mt-1.5 flex list-none flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground"
                data-testid="pair-error-remedies"
              >
                {restRemedies.map((remedy, index) => (
                  <li key={remedy} className="flex gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground"
                    >
                      {index + 2}
                    </span>
                    <span className="min-w-0">{t(`failure.remedy.${remedy}`, remedyValues)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Whichever of the two the primary button did not take. */}
            {action && canRetry ? (
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
            {onStartOver && (canRetry || action) ? (
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

          <pre
            className="mt-2 max-h-40 overflow-auto rounded-md border bg-background p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
            data-testid="pair-error-detail"
          >
            {formatPairDiagnostics(failure)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
