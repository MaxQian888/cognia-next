"use client"

/**
 * The one way a Source Control surface says "I could not ask git".
 *
 * Every read surface (diff, timeline, blame, remotes, tags, compare, rebase
 * todo, restore sources) fetches on its own. Before this existed a failed
 * fetch had no rendering at all: the surface stayed on its loading line or
 * fell through to its empty state, and "No remotes configured" is a claim
 * about the repository that a dropped transport has no business making.
 *
 * Two shapes, both carrying the backend's message and a retry:
 *  - `block` fills a pane (the diff area, a sheet body) as an `Empty`;
 *  - `inline` is one row inside a list or form that has other content.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

interface ReadErrorProps {
  message: string
  onRetry: () => void
  variant?: "block" | "inline"
  className?: string
  testId?: string
}

export function ReadError({
  message,
  onRetry,
  variant = "inline",
  className,
  testId = "sc-read-error",
}: ReadErrorProps) {
  const t = useTranslations("sourceControl")

  if (variant === "block") {
    return (
      <Empty className={cn("h-full border-0", className)} role="alert" data-testid={testId}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangleIcon />
          </EmptyMedia>
          <EmptyTitle>{t("read.failedTitle")}</EmptyTitle>
          <EmptyDescription className="break-words">{message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onRetry} data-testid={`${testId}-retry`}>
            <RefreshCwIcon className="size-3.5" />
            {t("repository.retry")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div
      role="alert"
      className={cn("flex min-w-0 items-center gap-2 px-3 py-2 text-xs", className)}
      data-testid={testId}
    >
      <AlertTriangleIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={message}>
        {t("read.failed", { message })}
      </span>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={onRetry}
        data-testid={`${testId}-retry`}
      >
        <RefreshCwIcon className="size-3" />
        {t("repository.retry")}
      </Button>
    </div>
  )
}
