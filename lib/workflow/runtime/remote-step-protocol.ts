import { HOST_DISPATCH_RESULT_CHUNK_CHARS } from "@/types/placement/host-dispatch"

export const STEP_EXECUTE_CHANNEL = "workflow://step-execute"
export const STEP_PENDING_PUSH_CHANNEL = "workflow://step-pending"
export const RESULT_CHUNK_CHARS = HOST_DISPATCH_RESULT_CHUNK_CHARS

export interface RemoteStepRequest {
  requestId: string
  targetDeviceId: string
  kind: string
  params: Record<string, unknown>
  runId: string
  stepId: string
  workflowId: string
  issuedAt: number
  timeoutAt: number
}

export type RemoteStepResult =
  { ok: true; output: unknown } | { ok: false; message: string; code?: string }
