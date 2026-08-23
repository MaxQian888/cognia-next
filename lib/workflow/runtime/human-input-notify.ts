import { isTauri } from "@/lib/platform/detect"
import type { WorkflowHumanInputRequest } from "@/types/workflow/human-input"
import { emitCompanionEvent } from "./companion-run-events"

export const HUMAN_INPUT_REQUEST_CHANNEL = "workflow://human-input-request"
export const HUMAN_INPUT_PENDING_PUSH_CHANNEL = "workflow://human-input-pending"
export const HUMAN_INPUT_RESOLVED_CHANNEL = "workflow://human-input-resolved"

export interface HumanInputNotifyDeps {
  notify?: (input: {
    source: "workflow"
    level: "warning"
    title: string
    body?: string
    href: string
    dedupeKey: string
    directed: true
    sourceRef: { kind: string; id: string }
  }) => Promise<string>
  emit?: (event: string, payload: unknown) => Promise<void>
  isTauriFn?: () => boolean
}

async function defaultNotify(
  input: Parameters<NonNullable<HumanInputNotifyDeps["notify"]>>[0]
): Promise<string> {
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input)
}

export async function notifyHumanInputRequested(
  request: WorkflowHumanInputRequest,
  deps: HumanInputNotifyDeps = {}
): Promise<void> {
  try {
    await (deps.notify ?? defaultNotify)({
      source: "workflow",
      level: "warning",
      title: request.title,
      ...(request.message ? { body: request.message } : {}),
      href: `/workflows/${request.workflowId}/runs/${request.runId}?humanInput=${request.id}`,
      dedupeKey: request.id,
      directed: true,
      sourceRef: { kind: "workflow-human-input", id: request.id },
    })
  } catch (error) {
    console.warn("human input notify: notification center delivery failed", error)
  }

  if (!(deps.isTauriFn ?? isTauri)()) return
  const emit = deps.emit ?? emitCompanionEvent
  try {
    await emit(HUMAN_INPUT_REQUEST_CHANNEL, request)
    await emit(HUMAN_INPUT_PENDING_PUSH_CHANNEL, {
      requestId: request.id,
      runId: request.runId,
      workflowId: request.workflowId,
    })
  } catch (error) {
    console.warn("human input notify: companion fan-out failed", error)
  }
}

export async function notifyHumanInputResolved(
  request: Pick<WorkflowHumanInputRequest, "id" | "runId" | "workflowId">,
  status: "completed" | "timed_out" | "cancelled",
  deps: HumanInputNotifyDeps = {}
): Promise<void> {
  if (!(deps.isTauriFn ?? isTauri)()) return
  try {
    await (deps.emit ?? emitCompanionEvent)(HUMAN_INPUT_RESOLVED_CHANNEL, {
      requestId: request.id,
      runId: request.runId,
      workflowId: request.workflowId,
      status,
    })
  } catch (error) {
    console.warn("human input notify: resolved fan-out failed", error)
  }
}
