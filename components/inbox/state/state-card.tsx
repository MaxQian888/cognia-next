"use client"

/**
 * Shared empty / loading / error / syncing state surface for the Inbox.
 *
 * Replaces three ad-hoc treatments that previously diverged in spacing,
 * icon choice, and retry affordance (sidebar empty list, conversation
 * list empty/filtered states, draft banner empty fallback). Now everything
 * routes through one compound:
 *
 *   <StateCard.Empty title="…" description="…" />
 *   <StateCard.Loading rows={6} />
 *   <StateCard.Error title="…" onRetry={…} stackTrace={…} />
 *   <StateCard.Syncing label="Loading from cache…" />
 *
 * Compound shape (Linear / Notion style) keeps related variants
 * discoverable without forcing every caller to learn a `variant` enum.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertOctagonIcon,
  ClipboardCheckIcon,
  ClipboardIcon,
  InboxIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export interface StateCardEmptyProps {
  title?: string
  description?: string
  /** Icon override; falls back to InboxIcon. */
  icon?: React.ReactNode
  className?: string
}

function StateCardEmpty({ title, description, icon, className }: StateCardEmptyProps) {
  const t = useTranslations("inbox.state.empty")
  return (
    <Card className={cn("border-dashed bg-transparent", className)} data-testid="state-card-empty">
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="text-muted-foreground">{icon ?? <InboxIcon className="h-6 w-6" />}</span>
        <p className="text-sm font-medium">{title ?? t("title")}</p>
        {description !== "" && (
          <p className="text-xs text-muted-foreground">{description ?? t("description")}</p>
        )}
      </CardContent>
    </Card>
  )
}

export interface StateCardLoadingProps {
  /** Skeleton row count (default 6). */
  rows?: number
  className?: string
}

function StateCardLoading({ rows = 6, className }: StateCardLoadingProps) {
  return (
    <div className={cn("flex flex-col gap-1 p-3", className)} data-testid="state-card-loading">
      {Array.from({ length: rows }).map((_, idx) => (
        <Skeleton key={idx} className="h-12 w-full rounded-md" />
      ))}
    </div>
  )
}

export interface StateCardErrorProps {
  title?: string
  description?: string
  /** Defaults to no-op; when set, a "Retry" button appears. */
  onRetry?: () => void
  /** Stack trace; when present, a "Copy stack" button is shown. */
  stackTrace?: string
  className?: string
}

function StateCardError({
  title,
  description,
  onRetry,
  stackTrace,
  className,
}: StateCardErrorProps) {
  const t = useTranslations("inbox.state.error")
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    if (!stackTrace) return
    try {
      await navigator.clipboard.writeText(stackTrace)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable on insecure origins; silently swallow.
    }
  }

  return (
    <Card
      className={cn("border-destructive/40 bg-destructive/5", className)}
      data-testid="state-card-error"
    >
      <CardContent className="flex flex-col gap-3 py-6">
        <div className="flex items-start gap-3">
          <AlertOctagonIcon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium text-destructive">{title ?? t("title")}</p>
            <p className="text-xs text-muted-foreground" data-testid="state-card-error-body">
              {description ?? t("description")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              data-testid="state-card-error-retry"
            >
              <RefreshCwIcon className="mr-1 h-3 w-3" aria-hidden />
              {t("retry")}
            </Button>
          )}
          {stackTrace && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void onCopy()}
              data-testid="state-card-error-copy"
              aria-live="polite"
            >
              {copied ? (
                <ClipboardCheckIcon className="mr-1 h-3 w-3" aria-hidden />
              ) : (
                <ClipboardIcon className="mr-1 h-3 w-3" aria-hidden />
              )}
              {copied ? t("copiedToast") : t("copyStack")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export interface StateCardSyncingProps {
  label?: string
  className?: string
}

function StateCardSyncing({ label, className }: StateCardSyncingProps) {
  const t = useTranslations("inbox.state.syncing")
  return (
    <div
      className={cn("flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground", className)}
      data-testid="state-card-syncing"
    >
      <LoaderIcon className="h-3 w-3 animate-spin" aria-hidden />
      <span>{label ?? t("label")}</span>
    </div>
  )
}

export const StateCard = {
  Empty: StateCardEmpty,
  Loading: StateCardLoading,
  Error: StateCardError,
  Syncing: StateCardSyncing,
}
