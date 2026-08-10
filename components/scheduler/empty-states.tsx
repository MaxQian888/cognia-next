"use client"

import { useTranslations } from "next-intl"
import { CalendarPlus, AlertTriangle, SearchX } from "lucide-react"
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

export interface TaskListEmptyStateProps {
  /**
   * "empty" — the source has no items at all. CTA prompts creation.
   * "filtered" — the filter/search yielded nothing. CTA clears filters.
   */
  variant?: "empty" | "filtered"
  onCreate?: () => void
  onClearFilters?: () => void
  className?: string
}

export function TaskListEmptyState({
  variant = "empty",
  onCreate,
  onClearFilters,
  className,
}: TaskListEmptyStateProps) {
  const t = useTranslations("scheduler")

  if (variant === "filtered") {
    return (
      <Empty
        data-testid="scheduler-empty-state-filtered"
        role="status"
        className={cn("gap-3 px-4 py-10", className)}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="text-sm">
            {t("emptyFilteredTitle") || "No matching tasks"}
          </EmptyTitle>
          <EmptyDescription className="max-w-[14rem] text-xs">
            {t("emptyFilteredDescription") || "Try different search terms or clear filters."}
          </EmptyDescription>
        </EmptyHeader>
        {onClearFilters && (
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={onClearFilters}
              data-testid="scheduler-empty-clear-filters"
            >
              {t("emptyClearFilters") || "Clear filters"}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    )
  }

  return (
    <Empty
      data-testid="scheduler-empty-state"
      role="status"
      className={cn("gap-3 px-4 py-12", className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
          <CalendarPlus aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("emptyTitle") || "No scheduled tasks yet"}</EmptyTitle>
        <EmptyDescription className="max-w-[16rem] text-xs">
          {t("emptyDescription") || "Create your first scheduled task to automate recurring work."}
        </EmptyDescription>
      </EmptyHeader>
      {onCreate && (
        <EmptyContent>
          <Button size="sm" onClick={onCreate} data-testid="scheduler-empty-create">
            {t("emptyCreateCta") || "Create task"}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

export interface PanelErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}

/**
 * Fallback rendered when a panel-level ErrorBoundary catches an exception.
 * Keeps the page operable: one panel crashes, the rest remain interactive.
 */
export function PanelErrorState({ title, description, onRetry, className }: PanelErrorStateProps) {
  const t = useTranslations("scheduler")
  return (
    <Empty
      data-testid="scheduler-panel-error"
      role="alert"
      className={cn("gap-3 px-4 py-10", className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <AlertTriangle aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">
          {title || t("panelErrorTitle") || "Something went wrong"}
        </EmptyTitle>
        <EmptyDescription className="max-w-[18rem] text-xs">
          {description || t("panelErrorDescription") || "This panel failed to render."}
        </EmptyDescription>
      </EmptyHeader>
      {onRetry && (
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            data-testid="scheduler-panel-error-retry"
          >
            {t("panelErrorRetry") || "Retry"}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
