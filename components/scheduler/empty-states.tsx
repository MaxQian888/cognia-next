"use client"

import { useTranslations } from "next-intl"
import { CalendarPlus, AlertTriangle, SearchX } from "lucide-react"
import { Button } from "@/components/ui/button"
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
      <div
        data-testid="scheduler-empty-state-filtered"
        role="status"
        className={cn(
          "flex flex-col items-center justify-center gap-3 px-4 py-10 text-center",
          className
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <SearchX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("emptyFilteredTitle") || "No matching tasks"}</p>
          <p className="text-xs text-muted-foreground max-w-[14rem]">
            {t("emptyFilteredDescription") || "Try different search terms or clear filters."}
          </p>
        </div>
        {onClearFilters && (
          <Button
            variant="outline"
            size="sm"
            onClick={onClearFilters}
            data-testid="scheduler-empty-clear-filters"
          >
            {t("emptyClearFilters") || "Clear filters"}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="scheduler-empty-state"
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-12 text-center",
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <CalendarPlus className="h-5 w-5 text-primary" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("emptyTitle") || "No scheduled tasks yet"}</p>
        <p className="text-xs text-muted-foreground max-w-[16rem]">
          {t("emptyDescription") || "Create your first scheduled task to automate recurring work."}
        </p>
      </div>
      {onCreate && (
        <Button size="sm" onClick={onCreate} data-testid="scheduler-empty-create">
          {t("emptyCreateCta") || "Create task"}
        </Button>
      )}
    </div>
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
    <div
      data-testid="scheduler-panel-error"
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-10 text-center",
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {title || t("panelErrorTitle") || "Something went wrong"}
        </p>
        <p className="text-xs text-muted-foreground max-w-[18rem]">
          {description || t("panelErrorDescription") || "This panel failed to render."}
        </p>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          data-testid="scheduler-panel-error-retry"
        >
          {t("panelErrorRetry") || "Retry"}
        </Button>
      )}
    </div>
  )
}
