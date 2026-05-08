/**
 * Thin wrapper around the Tauri scheduler_* commands registered in
 * `src-tauri/src/scheduler/commands.rs`. Routes through the module-scope
 * `transport` so Capacitor mode (M2.7) can transparently proxy these to
 * the desktop's axum API.
 */

import { transport } from "@/lib/tauri"
import type {
  CreateSystemTaskInput,
  SchedulerCapabilities,
  SystemTask,
  SystemTaskId,
  TaskConfirmationRequest,
  TaskOperationResponse,
  TaskRunResult,
  ValidationResult,
} from "@/types/scheduler/system-scheduler"

export async function getSchedulerCapabilities(): Promise<SchedulerCapabilities> {
  return transport.call<SchedulerCapabilities>("scheduler_get_capabilities")
}

export async function isSchedulerAvailable(): Promise<boolean> {
  return transport.call<boolean>("scheduler_is_available")
}

export async function isSchedulerElevated(): Promise<boolean> {
  return transport.call<boolean>("scheduler_is_elevated")
}

export async function listSystemTasks(): Promise<SystemTask[]> {
  return transport.call<SystemTask[]>("scheduler_list_tasks")
}

export async function getSystemTask(taskId: SystemTaskId): Promise<SystemTask | null> {
  return transport.call<SystemTask | null>("scheduler_get_task", { taskId })
}

export async function createSystemTask(
  input: CreateSystemTaskInput,
  confirmed = false
): Promise<TaskOperationResponse> {
  return transport.call<TaskOperationResponse>("scheduler_create_task", { input, confirmed })
}

export async function updateSystemTask(
  taskId: SystemTaskId,
  input: CreateSystemTaskInput,
  confirmed = false
): Promise<TaskOperationResponse> {
  return transport.call<TaskOperationResponse>("scheduler_update_task", {
    taskId,
    input,
    confirmed,
  })
}

export async function deleteSystemTask(taskId: SystemTaskId): Promise<boolean> {
  return transport.call<boolean>("scheduler_delete_task", { taskId })
}

export async function enableSystemTask(taskId: SystemTaskId): Promise<boolean> {
  return transport.call<boolean>("scheduler_enable_task", { taskId })
}

export async function disableSystemTask(taskId: SystemTaskId): Promise<boolean> {
  return transport.call<boolean>("scheduler_disable_task", { taskId })
}

export async function runSystemTaskNow(taskId: SystemTaskId): Promise<TaskRunResult> {
  return transport.call<TaskRunResult>("scheduler_run_task_now", { taskId })
}

export async function validateSystemTask(input: CreateSystemTaskInput): Promise<ValidationResult> {
  return transport.call<ValidationResult>("scheduler_validate_task", { input })
}

export async function confirmSystemTask(confirmationId: string): Promise<SystemTask> {
  return transport.call<SystemTask>("scheduler_confirm_task", { confirmationId })
}

export async function cancelConfirmation(confirmationId: string): Promise<boolean> {
  return transport.call<boolean>("scheduler_cancel_confirmation", { confirmationId })
}

// Alias used by the hook copied from Cognia (kept to avoid editing the
// hook's call site, which mirrors upstream verbatim).
export const cancelTaskConfirmation = cancelConfirmation

export async function requestSchedulerElevation(): Promise<boolean> {
  return transport.call<boolean>("scheduler_request_elevation")
}

export async function getPendingConfirmations(): Promise<TaskConfirmationRequest[]> {
  return transport.call<TaskConfirmationRequest[]>("scheduler_get_pending_confirmations")
}
