"use client"

import { useTranslations } from "next-intl"
import { Plus, Settings } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  AdminElevationDialog,
  SystemTaskForm,
  TaskConfirmationDialog,
  TaskForm,
} from "@/components/scheduler"
import type {
  ScheduledTask,
  CreateScheduledTaskInput,
  CreateSystemTaskInput,
  SchedulerCapabilities,
  SystemTask,
  TaskConfirmationRequest,
} from "@/types/scheduler"

export interface SchedulerDialogsProps {
  // Create task sheet
  showCreateSheet: boolean
  onShowCreateSheetChange: (open: boolean) => void
  onCreateTask: (input: CreateScheduledTaskInput) => Promise<void>
  isSubmitting: boolean

  // Edit task sheet
  showEditSheet: boolean
  onShowEditSheetChange: (open: boolean) => void
  onEditTask: (input: CreateScheduledTaskInput) => Promise<void>
  selectedTask: ScheduledTask | undefined

  // Create system task sheet
  showSystemCreateSheet: boolean
  onShowSystemCreateSheetChange: (open: boolean) => void
  onCreateSystemTask: (input: CreateSystemTaskInput) => Promise<void>
  systemSubmitting: boolean
  systemCapabilities?: SchedulerCapabilities | null

  // Edit system task sheet
  showSystemEditSheet: boolean
  onShowSystemEditSheetChange: (open: boolean) => void
  onEditSystemTask: (input: CreateSystemTaskInput) => Promise<void>
  selectedSystemTask: SystemTask | null

  // Delete confirmation
  deleteTaskId: string | null
  onDeleteTaskIdChange: (id: string | null) => void
  onDeleteConfirm: () => Promise<void>

  // System delete confirmation
  systemDeleteTaskId: string | null
  onSystemDeleteTaskIdChange: (id: string | null) => void
  onSystemDeleteConfirm: () => Promise<void>

  // Task confirmation dialog
  pendingConfirmation: TaskConfirmationRequest | null
  onConfirmPending: () => void
  onCancelPending: () => void

  // Admin elevation dialog
  showAdminDialog: boolean
  onShowAdminDialogChange: (open: boolean) => void
  onRequestElevation: () => Promise<void>

  // Existing tasks for dependency selection
  existingTasks?: ScheduledTask[]
}

export function SchedulerDialogs({
  showCreateSheet,
  onShowCreateSheetChange,
  onCreateTask,
  isSubmitting,
  showEditSheet,
  onShowEditSheetChange,
  onEditTask,
  selectedTask,
  showSystemCreateSheet,
  onShowSystemCreateSheetChange,
  onCreateSystemTask,
  systemSubmitting,
  systemCapabilities,
  showSystemEditSheet,
  onShowSystemEditSheetChange,
  onEditSystemTask,
  selectedSystemTask,
  deleteTaskId,
  onDeleteTaskIdChange,
  onDeleteConfirm,
  systemDeleteTaskId,
  onSystemDeleteTaskIdChange,
  onSystemDeleteConfirm,
  pendingConfirmation,
  onConfirmPending,
  onCancelPending,
  showAdminDialog,
  onShowAdminDialogChange,
  onRequestElevation,
  existingTasks,
}: SchedulerDialogsProps) {
  const t = useTranslations("scheduler")

  return (
    <>
      {/* Create Task Sheet */}
      <Sheet open={showCreateSheet} onOpenChange={onShowCreateSheetChange}>
        <SheetContent className="w-full sm:w-[540px] sm:max-w-[540px] overflow-y-auto border-l bg-gradient-to-b from-background to-muted/20">
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2.5 text-lg">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                <Plus className="h-5 w-5 text-primary" />
              </div>
              {t("createTask") || "Create Task"}
            </SheetTitle>
            <SheetDescription className="text-sm">
              {t("createTaskDescription") ||
                "Set up a new scheduled task with triggers, notifications and more"}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            <TaskForm
              onSubmit={onCreateTask}
              onCancel={() => onShowCreateSheetChange(false)}
              isSubmitting={isSubmitting}
              existingTasks={existingTasks}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Edit Task Sheet */}
      <Sheet open={showEditSheet} onOpenChange={onShowEditSheetChange}>
        <SheetContent className="w-full sm:w-[540px] sm:max-w-[540px] overflow-y-auto border-l bg-gradient-to-b from-background to-muted/20">
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2.5 text-lg">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10">
                <Settings className="h-5 w-5 text-blue-500" />
              </div>
              {t("editTask") || "Edit Task"}
            </SheetTitle>
            <SheetDescription className="text-sm">
              {t("editTaskDescription") || "Modify task settings and configurations"}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            {selectedTask && (
              <TaskForm
                initialValues={{
                  name: selectedTask.name,
                  description: selectedTask.description,
                  type: selectedTask.type,
                  trigger: selectedTask.trigger,
                  payload: selectedTask.payload,
                  config: selectedTask.config,
                  notification: selectedTask.notification,
                }}
                onSubmit={onEditTask}
                onCancel={() => onShowEditSheetChange(false)}
                isSubmitting={isSubmitting}
                existingTasks={existingTasks?.filter((t) => t.id !== selectedTask.id)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Create System Task Sheet */}
      <Sheet open={showSystemCreateSheet} onOpenChange={onShowSystemCreateSheetChange}>
        <SheetContent className="w-full sm:w-[540px] sm:max-w-[540px] overflow-y-auto border-l bg-gradient-to-b from-background to-muted/20">
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2.5 text-lg">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                <Plus className="h-5 w-5 text-primary" />
              </div>
              {t("createSystemTask") || "Create System Task"}
            </SheetTitle>
            <SheetDescription className="text-sm">
              {t("systemSchedulerDescription") || "Manage OS-level scheduled tasks"}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            <SystemTaskForm
              capabilities={systemCapabilities}
              onSubmit={onCreateSystemTask}
              onCancel={() => onShowSystemCreateSheetChange(false)}
              isSubmitting={systemSubmitting}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Edit System Task Sheet */}
      <Sheet open={showSystemEditSheet} onOpenChange={onShowSystemEditSheetChange}>
        <SheetContent className="w-full sm:w-[540px] sm:max-w-[540px] overflow-y-auto border-l bg-gradient-to-b from-background to-muted/20">
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2.5 text-lg">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10">
                <Settings className="h-5 w-5 text-blue-500" />
              </div>
              {t("editSystemTask") || "Edit System Task"}
            </SheetTitle>
            <SheetDescription className="text-sm">
              {t("systemSchedulerDescription") || "Manage OS-level scheduled tasks"}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            {selectedSystemTask && (
              <SystemTaskForm
                initialValues={{
                  name: selectedSystemTask.name,
                  description: selectedSystemTask.description,
                  trigger: selectedSystemTask.trigger,
                  action: selectedSystemTask.action,
                  run_level: selectedSystemTask.run_level,
                  tags: selectedSystemTask.tags,
                }}
                capabilities={systemCapabilities}
                onSubmit={onEditSystemTask}
                onCancel={() => onShowSystemEditSheetChange(false)}
                isSubmitting={systemSubmitting}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTaskId} onOpenChange={() => onDeleteTaskIdChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTask") || "Delete Task"}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteTaskConfirm") ||
                "Are you sure you want to delete this task? This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel") || "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeleteConfirm}
              className="bg-destructive text-destructive-foreground"
            >
              {t("delete") || "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete System Task Confirmation */}
      <AlertDialog
        open={!!systemDeleteTaskId}
        onOpenChange={() => onSystemDeleteTaskIdChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTask") || "Delete Task"}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteTaskConfirm") ||
                "Are you sure you want to delete this task? This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel") || "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onSystemDeleteConfirm}
              className="bg-destructive text-destructive-foreground"
            >
              {t("delete") || "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TaskConfirmationDialog
        open={!!pendingConfirmation}
        confirmation={pendingConfirmation}
        loading={systemSubmitting}
        onConfirm={onConfirmPending}
        onCancel={onCancelPending}
      />

      <AdminElevationDialog
        open={showAdminDialog}
        loading={systemSubmitting}
        onCancel={() => onShowAdminDialogChange(false)}
        onRequestElevation={onRequestElevation}
      />
    </>
  )
}
