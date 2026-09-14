"use client"

/**
 * The scheduler's header (ADR-0179 §5).
 *
 * `FeaturePageHeader` in its management variant, the band every feature
 * route uses. `summary` names the host whose schedule is on screen; `status`
 * says when that schedule is suspended, only ticks while the app is open, or
 * when the app scheduler itself is stopped. The host switch and the timing
 * authority wait in a Popover behind the controls row.
 *
 * The breadcrumb leaf that used to repeat the selected item's name is gone:
 * the item's own masthead names it.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  CogIcon,
  DownloadIcon,
  LayoutGridIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type { SchedulerStatus } from "@/stores/scheduler/scheduler-store"

import {
  SchedulerHostPopover,
  SchedulerHostStatusBadge,
  SchedulerHostSummaryLine,
  useSchedulerHostSummary,
} from "./scheduler-host-popover"

export interface SchedulerPageHeaderProps {
  schedulerStatus: SchedulerStatus
  isRefreshing?: boolean
  /** Renders the list-pane toggle; needs a `SidebarProvider` above. */
  showListTrigger?: boolean
  onCreate: () => void
  onCreateSystemTask?: () => void
  onCreateWorkflowTrigger?: () => void
  onOpenBackupSettings?: () => void
  onOpenPluginSettings?: () => void
  onRefresh: () => void
  onExport: () => void
  onImport: () => void
  onOpenTemplates: () => void
  onCleanup: () => void
}

const STATUS_TONE: Record<SchedulerStatus, string> = {
  running: "text-emerald-600 dark:text-emerald-400",
  idle: "text-muted-foreground",
  stopped: "text-amber-600 dark:text-amber-400",
}

const STATUS_KEY: Record<
  SchedulerStatus,
  "schedulerRunning" | "schedulerIdle" | "schedulerStopped"
> = {
  running: "schedulerRunning",
  idle: "schedulerIdle",
  stopped: "schedulerStopped",
}

export function SchedulerPageHeader({
  schedulerStatus,
  isRefreshing = false,
  showListTrigger = true,
  onCreate,
  onCreateSystemTask,
  onCreateWorkflowTrigger,
  onOpenBackupSettings,
  onOpenPluginSettings,
  onRefresh,
  onExport,
  onImport,
  onOpenTemplates,
  onCleanup,
}: SchedulerPageHeaderProps) {
  const t = useTranslations("scheduler")
  const summary = useSchedulerHostSummary()

  return (
    <FeaturePageHeader
      variant="management"
      icon={<CalendarClockIcon />}
      title={t("title")}
      breadcrumb={showListTrigger ? <SidebarTrigger className="size-7 shrink-0" /> : undefined}
      summary={<SchedulerHostSummaryLine summary={summary} />}
      status={
        <span className="flex items-center gap-1.5">
          <SchedulerHostStatusBadge summary={summary} />
          <Badge
            variant="outline"
            className={cn("h-5 gap-1 text-[10px] font-normal", STATUS_TONE[schedulerStatus])}
            data-testid="scheduler-status-badge"
            data-status={schedulerStatus}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {t(STATUS_KEY[schedulerStatus])}
          </Badge>
        </span>
      }
      controls={<SchedulerHostPopover />}
      overflowLabel={t("moreOptions")}
      overflowActions={[
        {
          id: "templates",
          label: t("templateGallery.title"),
          icon: LayoutGridIcon,
          onSelect: onOpenTemplates,
        },
        { id: "export", label: t("exportTasks"), icon: DownloadIcon, onSelect: onExport },
        { id: "import", label: t("importTasks"), icon: UploadIcon, onSelect: onImport },
        { id: "cleanup", label: t("cleanupOldExecutions"), icon: Trash2Icon, onSelect: onCleanup },
      ]}
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={t("refresh")}
            data-testid="scheduler-refresh-button"
          >
            <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          </Button>
          <div className="inline-flex">
            <Button
              size="sm"
              onClick={onCreate}
              data-testid="scheduler-new-task-button"
              className="rounded-r-none"
            >
              <PlusIcon className="size-3.5" />
              <span className="ml-1 hidden sm:inline">{t("createTask")}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="default"
                  className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  data-testid="scheduler-new-task-kind-menu"
                  aria-label={t("createTaskKind")}
                >
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onCreate} data-testid="scheduler-new-app-task">
                  <CalendarClockIcon className="mr-2 size-3.5" />
                  {t("kindFilter.app")}
                </DropdownMenuItem>
                {onCreateWorkflowTrigger ? (
                  <DropdownMenuItem
                    onClick={onCreateWorkflowTrigger}
                    data-testid="scheduler-new-workflow-trigger"
                  >
                    <WorkflowIcon className="mr-2 size-3.5" />
                    {t("kindFilter.workflow")}
                  </DropdownMenuItem>
                ) : null}
                {onOpenBackupSettings ? (
                  <DropdownMenuItem
                    onClick={onOpenBackupSettings}
                    data-testid="scheduler-open-backup-settings"
                  >
                    <ArchiveIcon className="mr-2 size-3.5" />
                    {t("kindFilter.backup")}
                  </DropdownMenuItem>
                ) : null}
                {onOpenPluginSettings ? (
                  <DropdownMenuItem
                    onClick={onOpenPluginSettings}
                    data-testid="scheduler-open-plugin-settings"
                  >
                    <PlugIcon className="mr-2 size-3.5" />
                    {t("kindFilter.plugin")}
                  </DropdownMenuItem>
                ) : null}
                {onCreateSystemTask ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={onCreateSystemTask}
                      data-testid="scheduler-new-system-task"
                    >
                      <CogIcon className="mr-2 size-3.5" />
                      {t("kindFilter.system")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      }
    />
  )
}
