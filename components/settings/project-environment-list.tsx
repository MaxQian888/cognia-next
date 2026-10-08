"use client"

/**
 * The environments a workspace defines, as a list to pick from.
 *
 * It replaces a `Select` whose trigger showed one name and nothing else. Which
 * environment is the workspace default, which is switched off, and whether its
 * setup last succeeded were all invisible until each was opened in turn, and
 * "New environment" sat beside the dropdown as a second, unrelated control. A
 * list answers all three at a glance and keeps creating one in the same place
 * as choosing one.
 *
 * Rows rather than cards: they are entries in one list, so they share one
 * hairline-divided column instead of each drawing a frame. The same component
 * serves the workspace page (beside the editor, from a wide pane up) and the
 * session sheet (above it), which is why nothing here assumes a width.
 *
 * A definition that has never been saved is listed first and marked so. It
 * used to exist only as the editor's content, so choosing another environment
 * dropped it without a trace.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { PlusIcon, RotateCcwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { cn } from "@/lib/utils"
import type {
  ProjectEnvironment,
  ProjectEnvironmentInitializationStatus,
} from "@/types/project-environment"

/** One status, one tone. `never` and `cancelled` are not news. */
const STATUS_DOT: Record<ProjectEnvironmentInitializationStatus, string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  bypassed: "bg-amber-500",
  cancelled: "bg-muted-foreground/40",
}

export interface ProjectEnvironmentListProps {
  environments: readonly ProjectEnvironment[]
  status: "loading" | "ready" | "error"
  /** The load failure, verbatim. */
  error?: string
  selectedId: string | null
  /** A definition being edited that has not been saved yet. */
  unsaved?: { id: string; name: string } | null
  defaultEnvironmentId?: string
  onSelect(id: string): void
  onCreate(): void
  onRetry(): void
  /** While a save, run or delete is in flight. */
  disabled?: boolean
  className?: string
}

export function ProjectEnvironmentList({
  environments,
  status,
  error,
  selectedId,
  unsaved,
  defaultEnvironmentId,
  onSelect,
  onCreate,
  onRetry,
  disabled,
  className,
}: ProjectEnvironmentListProps) {
  const t = useTranslations("projectEnvironment")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const showLoading = useDeferredLoading(status === "loading")

  const lastRun = (environment: ProjectEnvironment) => {
    const run = environment.lastInitialization
    if (!run) return t("lastRunNever")
    return t("lastRun", {
      status: t(`initStatus.${run.status}`),
      time: format.relativeTime(new Date(run.completedAt ?? run.startedAt), now),
    })
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {status === "error" ? (
        <div role="alert" className="space-y-2 py-1" data-testid="project-environment-list-error">
          <p className="text-xs text-destructive">{t("loadFailed", { message: error ?? "" })}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCcwIcon className="size-3.5" />
            {t("retryLoad")}
          </Button>
        </div>
      ) : status === "loading" ? (
        showLoading ? (
          <div
            role="status"
            className="space-y-2 py-1"
            data-testid="project-environment-list-loading"
          >
            <span className="sr-only">{t("loadingList")}</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : null
      ) : environments.length === 0 && !unsaved ? (
        <div className="py-1" data-testid="project-environment-list-empty">
          <p className="text-xs font-medium">{t("listEmptyTitle")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t("listEmptyBody")}
          </p>
        </div>
      ) : (
        <ul
          aria-label={t("listLabel")}
          className="divide-y border-y"
          data-testid="project-environment-list"
        >
          {unsaved ? (
            <li>
              <Row
                selected={selectedId === unsaved.id}
                disabled={disabled}
                onSelect={() => onSelect(unsaved.id)}
                name={unsaved.name.trim() || t("unnamed")}
                detail={t("newUnsaved")}
                dot="bg-muted-foreground/40"
                badges={
                  <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                    {t("unsavedBadge")}
                  </Badge>
                }
                testId={`project-environment-row-${unsaved.id}`}
              />
            </li>
          ) : null}
          {environments.map((environment) => (
            <li key={environment.id}>
              <Row
                selected={selectedId === environment.id}
                disabled={disabled}
                onSelect={() => onSelect(environment.id)}
                name={environment.name.trim() || t("unnamed")}
                detail={lastRun(environment)}
                dot={STATUS_DOT[environment.lastInitialization?.status ?? "never"]}
                muted={!environment.isEnabled}
                badges={
                  <>
                    {environment.id === defaultEnvironmentId ? (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                        {t("defaultBadge")}
                      </Badge>
                    ) : null}
                    {environment.isEnabled ? null : (
                      <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                        {t("disabledBadge")}
                      </Badge>
                    )}
                  </>
                }
                testId={`project-environment-row-${environment.id}`}
              />
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2 self-start"
        disabled={disabled || status === "loading"}
        onClick={onCreate}
        data-testid="project-environment-create"
      >
        <PlusIcon className="size-3.5" />
        {t("create")}
      </Button>
    </div>
  )
}

function Row({
  selected,
  disabled,
  onSelect,
  name,
  detail,
  dot,
  muted,
  badges,
  testId,
}: {
  selected: boolean
  disabled?: boolean
  onSelect(): void
  name: string
  detail: string
  dot: string
  muted?: boolean
  badges: React.ReactNode
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={selected ? "true" : undefined}
      data-testid={testId}
      className={cn(
        // Selection is a tint and a leading rule, not a frame: the row stays
        // part of the list it sits in.
        "flex w-full items-start gap-2 border-l-2 border-transparent px-2 py-2 text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected && "border-l-primary bg-muted/70"
      )}
    >
      <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn("min-w-0 truncate text-xs font-medium", muted && "text-muted-foreground")}
          >
            {name}
          </span>
          {badges}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}
