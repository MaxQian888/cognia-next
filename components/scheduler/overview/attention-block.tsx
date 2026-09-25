"use client"

/**
 * What needs you (ADR-0179 §3): the first block on the overview.
 *
 * One row per `AttentionSignal`, most severe first. A row about an item is
 * a button that opens the item; a row about the page (a source that failed,
 * a suspended host, a quota) carries the one action that answers it. The
 * empty state says so, and says when the next thing fires, so a quiet
 * schedule reads as quiet rather than as broken.
 */

import { useTranslations } from "next-intl"
import { CheckCircle2Icon, ChevronRightIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import type { Occurrence } from "@/lib/scheduler/upcoming-occurrences"

import { SEVERITY_TONE } from "../kind-visuals"

export interface AttentionBlockProps {
  signals: readonly AttentionSignal[]
  /** The next projected fire, for the empty state. */
  next?: Occurrence
  onSelectItem: (unifiedId: string) => void
  /** Stop a running run named by its unified id. */
  onCancelRun?: (runUnifiedId: string) => void
  onRetrySources?: () => void
  onSwitchToPaired?: () => void
  onOpenPolicy?: () => void
  className?: string
}

/** The sentence the block shows for a signal. */
export function useAttentionSentence(): (signal: AttentionSignal) => string {
  const t = useTranslations("scheduler.attention.block")
  const tKind = useTranslations("scheduler.kindFilter")
  return (signal) => {
    const name = signal.itemName ?? ""
    switch (signal.kind) {
      case "auto-paused":
        return t("autoPaused", { name, count: signal.count ?? 0 })
      case "needs-approval":
        if (signal.tools && signal.roots) {
          return t("needsApprovalToolsAndTrust", { name, tools: signal.tools, roots: signal.roots })
        }
        if (signal.tools) return t("needsApprovalTools", { name, tools: signal.tools })
        if (signal.roots) return t("needsApprovalTrust", { name, roots: signal.roots })
        return t("needsApproval", { name })
      case "consecutive-failures":
        return t("consecutiveFailures", { name, count: signal.count ?? 0 })
      case "last-run-failed":
        return signal.detail
          ? t("lastRunFailedWith", { name, error: signal.detail })
          : t("lastRunFailed", { name })
      case "unsupported-type":
        return t("unsupportedType", { name })
      case "running":
        return signal.processCount
          ? t("runningWithProcesses", { name, count: signal.processCount })
          : t("running", { name })
      case "source-failed":
        return t("sourceFailed", {
          kind: signal.sourceKind ? tKind(signal.sourceKind) : "",
          error: signal.detail ?? "",
        })
      case "awaiting-confirmation":
        return t("awaitingConfirmation", { count: signal.count ?? 0 })
      case "host-suspended":
        return t("hostSuspended")
      case "quota-near-limit":
        return t("quotaNearLimit", {
          source: signal.writeSource ?? "",
          count: signal.count ?? 0,
          limit: signal.limit ?? 0,
        })
    }
  }
}

export function AttentionBlock({
  signals,
  next,
  onSelectItem,
  onCancelRun,
  onRetrySources,
  onSwitchToPaired,
  onOpenPolicy,
  className,
}: AttentionBlockProps) {
  const t = useTranslations("scheduler.attention")
  const sentence = useAttentionSentence()

  if (signals.length === 0) {
    return (
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg border border-dashed px-3.5 py-3",
          className
        )}
        data-testid="attention-empty"
      >
        <CheckCircle2Icon
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div className="min-w-0 text-xs">
          <p className="font-medium">{t("emptyTitle")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {next
              ? t("emptyNext", { name: next.taskName, when: next.date.toLocaleString() })
              : t("emptyNothingScheduled")}
          </p>
        </div>
      </div>
    )
  }

  return (
    <ol className={cn("flex flex-col gap-1", className)} data-testid="attention-block">
      {signals.map((signal) => {
        const tone = SEVERITY_TONE[signal.severity]
        const text = sentence(signal)
        const action = ((): React.ReactNode => {
          if (signal.kind === "running" && signal.runUnifiedId && onCancelRun) {
            const runId = signal.runUnifiedId
            return (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => onCancelRun(runId)}
                data-testid="attention-stop"
              >
                <SquareIcon className="size-3" aria-hidden="true" />
                {t("actions.stop")}
              </Button>
            )
          }
          if (signal.kind === "source-failed" && onRetrySources) {
            return (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 px-2 text-[11px]"
                onClick={onRetrySources}
                data-testid="attention-retry"
              >
                {t("actions.retry")}
              </Button>
            )
          }
          if (signal.kind === "host-suspended" && onSwitchToPaired) {
            return (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 px-2 text-[11px]"
                onClick={onSwitchToPaired}
                data-testid="attention-switch-host"
              >
                {t("actions.managePaired")}
              </Button>
            )
          }
          if (signal.kind === "quota-near-limit" && onOpenPolicy) {
            return (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 px-2 text-[11px]"
                onClick={onOpenPolicy}
                data-testid="attention-open-policy"
              >
                {t("actions.openPolicy")}
              </Button>
            )
          }
          return null
        })()

        const body = (
          <>
            <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone.dot)} />
            <span className={cn("min-w-0 flex-1 text-xs leading-snug", tone.text)}>{text}</span>
          </>
        )

        return (
          <li
            key={signal.id}
            className={cn("flex items-start gap-2 rounded-md border px-2.5 py-1.5", tone.border)}
            data-testid={`attention-${signal.kind}`}
            data-severity={signal.severity}
          >
            {signal.itemUnifiedId ? (
              <button
                type="button"
                onClick={() => onSelectItem(signal.itemUnifiedId!)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="attention-open-item"
              >
                {body}
                <ChevronRightIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-start gap-2">{body}</span>
            )}
            {action}
          </li>
        )
      })}
    </ol>
  )
}
