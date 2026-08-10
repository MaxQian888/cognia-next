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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
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
    <Empty
      className={cn("rounded-none border-0 p-4 md:p-6", className)}
      data-testid="state-card-empty"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <InboxIcon className="size-6" />}</EmptyMedia>
        <EmptyTitle className="text-sm">{title ?? t("title")}</EmptyTitle>
        {description !== "" && (
          <EmptyDescription className="text-xs">{description ?? t("description")}</EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
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
    <Alert
      variant="destructive"
      className={cn("rounded-none border-x-0 bg-transparent", className)}
      data-testid="state-card-error"
    >
      <AlertOctagonIcon aria-hidden />
      <AlertTitle>{title ?? t("title")}</AlertTitle>
      <AlertDescription>
        <p className="text-xs" data-testid="state-card-error-body">
          {description ?? t("description")}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              data-testid="state-card-error-retry"
            >
              <RefreshCwIcon className="size-3" aria-hidden />
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
                <ClipboardCheckIcon className="size-3" aria-hidden />
              ) : (
                <ClipboardIcon className="size-3" aria-hidden />
              )}
              {copied ? t("copiedToast") : t("copyStack")}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
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
