"use client"

/**
 * SchedulerContentHeader - Top bar for the main content area (SidebarInset)
 * Renders breadcrumb, overflow menu, refresh button, and New Task button.
 */

import { useTranslations } from "next-intl"
import {
  Plus,
  RefreshCw,
  MoreVertical,
  LayoutGrid,
  Download,
  Upload,
  Trash2,
  ChevronDown,
  ChevronRight,
  Calendar,
  Workflow,
  Archive,
  Plug,
  Cog,
} from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export interface SchedulerContentHeaderProps {
  selectedTaskName?: string | null
  isRefreshing?: boolean
  onCreate: () => void
  onCreateSystemTask?: () => void
  /** When supplied, opens the workflow editor's "new workflow" route. */
  onCreateWorkflowTrigger?: () => void
  /** Deep-links to backup settings. */
  onOpenBackupSettings?: () => void
  /** Deep-links to plugin settings. */
  onOpenPluginSettings?: () => void
  onRefresh: () => void
  onExport?: () => void
  onImport?: () => void
  onOpenTemplates?: () => void
  onCleanup?: () => void
}

export function SchedulerContentHeader({
  selectedTaskName,
  isRefreshing = false,
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
}: SchedulerContentHeaderProps) {
  const t = useTranslations("scheduler")

  return (
    <FeaturePageHeader
      icon={<Calendar />}
      title={t("title")}
      context={
        <nav
          aria-label={t("breadcrumb")}
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <ChevronRight className="size-3 shrink-0" />
          <span
            data-testid="scheduler-breadcrumb-leaf"
            className={cn(
              "truncate",
              selectedTaskName ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {selectedTaskName ?? t("overview")}
          </span>
        </nav>
      }
      breadcrumb={
        <div className="flex items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0" />
          <Separator orientation="vertical" className="h-4" />
        </div>
      }
      actions={
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                aria-label={t("moreOptions")}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onOpenTemplates}>
                <LayoutGrid className="mr-2 h-4 w-4" />
                {t("templateGallery.title")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport}>
                <Download className="mr-2 h-4 w-4" />
                {t("exportTasks")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onImport}>
                <Upload className="mr-2 h-4 w-4" />
                {t("importTasks")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCleanup}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t("quickActions.cleanup")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={t("refresh")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>

          <div className="inline-flex">
            <Button
              size="sm"
              onClick={onCreate}
              data-testid="scheduler-new-task-button"
              className="rounded-r-none"
            >
              <Plus className="h-3.5 w-3.5" />
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
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onCreate} data-testid="scheduler-new-app-task">
                  <Calendar className="mr-2 h-3.5 w-3.5" />
                  {t("kindFilter.app")}
                </DropdownMenuItem>
                {onCreateWorkflowTrigger && (
                  <DropdownMenuItem
                    onClick={onCreateWorkflowTrigger}
                    data-testid="scheduler-new-workflow-trigger"
                  >
                    <Workflow className="mr-2 h-3.5 w-3.5" />
                    {t("kindFilter.workflow")}
                  </DropdownMenuItem>
                )}
                {onOpenBackupSettings && (
                  <DropdownMenuItem
                    onClick={onOpenBackupSettings}
                    data-testid="scheduler-open-backup-settings"
                  >
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    {t("kindFilter.backup")}
                  </DropdownMenuItem>
                )}
                {onOpenPluginSettings && (
                  <DropdownMenuItem
                    onClick={onOpenPluginSettings}
                    data-testid="scheduler-open-plugin-settings"
                  >
                    <Plug className="mr-2 h-3.5 w-3.5" />
                    {t("kindFilter.plugin")}
                  </DropdownMenuItem>
                )}
                {onCreateSystemTask && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={onCreateSystemTask}
                      data-testid="scheduler-new-system-task"
                    >
                      <Cog className="mr-2 h-3.5 w-3.5" />
                      {t("kindFilter.system")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      }
    />
  )
}
