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
    <div className="border-b bg-background/95 backdrop-blur px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        {/* Sidebar trigger */}
        <SidebarTrigger className="h-8 w-8" />

        {/* Vertical separator */}
        <Separator orientation="vertical" className="h-4" />

        {/* Breadcrumb */}
        <nav
          aria-label={t("breadcrumb")}
          className="flex items-center gap-1 text-sm text-muted-foreground"
        >
          <span className="font-medium text-foreground">{t("title") || "Scheduler"}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          <span
            data-testid="scheduler-breadcrumb-leaf"
            className={cn(
              "truncate max-w-[200px]",
              selectedTaskName ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {selectedTaskName ?? (t("overview") || "Overview")}
          </span>
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Overflow menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("moreOptions")}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onOpenTemplates}>
              <LayoutGrid className="mr-2 h-4 w-4" />
              {t("templateGallery.title") || "Templates"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExport}>
              <Download className="mr-2 h-4 w-4" />
              {t("exportTasks") || "Export"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onImport}>
              <Upload className="mr-2 h-4 w-4" />
              {t("importTasks") || "Import"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onCleanup}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t("quickActions.cleanup") || "Cleanup"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Refresh */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={t("refresh")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>

        {/* Split-button "New Task" — primary action stays "create app task",
            the caret reveals the per-kind menu. Preserves the existing
            data-testid so legacy tests keep working. */}
        <div className="inline-flex">
          <Button
            size="sm"
            onClick={onCreate}
            data-testid="scheduler-new-task-button"
            className="rounded-r-none"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline ml-1">{t("createTask") || "New Task"}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="default"
                className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                data-testid="scheduler-new-task-kind-menu"
                aria-label={t("createTaskKind") || "Choose task kind"}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onCreate} data-testid="scheduler-new-app-task">
                <Calendar className="mr-2 h-3.5 w-3.5" />
                {t("kindFilter.app") || "App task"}
              </DropdownMenuItem>
              {onCreateWorkflowTrigger && (
                <DropdownMenuItem
                  onClick={onCreateWorkflowTrigger}
                  data-testid="scheduler-new-workflow-trigger"
                >
                  <Workflow className="mr-2 h-3.5 w-3.5" />
                  {t("kindFilter.workflow") || "Workflow trigger"}
                </DropdownMenuItem>
              )}
              {onOpenBackupSettings && (
                <DropdownMenuItem
                  onClick={onOpenBackupSettings}
                  data-testid="scheduler-open-backup-settings"
                >
                  <Archive className="mr-2 h-3.5 w-3.5" />
                  {t("kindFilter.backup") || "Backup schedule"}
                </DropdownMenuItem>
              )}
              {onOpenPluginSettings && (
                <DropdownMenuItem
                  onClick={onOpenPluginSettings}
                  data-testid="scheduler-open-plugin-settings"
                >
                  <Plug className="mr-2 h-3.5 w-3.5" />
                  {t("kindFilter.plugin") || "Plugin job"}
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
                    {t("kindFilter.system") || "System task"}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
