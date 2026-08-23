/** Durable authored human-input contract shared by editor, runtime, Portal, and Companion. */

import type { EncryptedContentEnvelopeV1 } from "@cognia/rag"

export type HumanInputFieldType =
  | "short-text"
  | "long-text"
  | "number"
  | "boolean"
  | "single-select"
  | "multi-select"
  | "file"
  | "file-list"

export interface HumanInputFieldOption {
  value: string
  label: string
}

export interface HumanInputField {
  id: string
  type: HumanInputFieldType
  label: string
  description?: string
  required?: boolean
  sensitive?: boolean
  options?: HumanInputFieldOption[]
  min?: number
  max?: number
  accept?: string[]
  maxFiles?: number
}

export interface HumanInputAction {
  /** Stable routing handle authored on the workflow node. */
  id: string
  label: string
  tone?: "primary" | "secondary" | "destructive"
}

export type HumanInputAssignee =
  { kind: "initiator" } | { kind: "member"; id: string } | { kind: "group"; id: string }

export type HumanInputCompletionPolicy =
  { mode: "any" } | { mode: "all" } | { mode: "quorum"; count: number }

export type HumanInputValue = string | number | boolean | string[] | null

export interface WorkflowHumanInputRequest {
  id: string
  accountId: string
  waitpointId: string
  status: "pending" | "completed" | "timed_out" | "cancelled"
  runId: string
  workflowId: string
  stepId: string
  /** Frozen authenticated subject that started the run, when known. */
  initiatorId?: string
  title: string
  message?: string
  fields: HumanInputField[]
  actions: HumanInputAction[]
  assignees: HumanInputAssignee[]
  completionPolicy: HumanInputCompletionPolicy
  /** Sensitive submission values may be retained for fewer days than request metadata. */
  sensitiveRetentionDays?: number
  createdAt: number
  expiresAt: number
  updatedAt: number
  completedAt?: number
  finalActionId?: string
}

export interface WorkflowHumanInputSubmission {
  id: string
  requestId: string
  responderId: string
  /** Frozen selectors this authenticated responder satisfied at submission time. */
  matchedAssigneeKeys: string[]
  actionId: string
  values: Record<string, HumanInputValue>
  submittedAt: number
  /** True when encrypted sensitive values were already removed by retention policy. */
  sensitiveValuesExpired?: true
}

/** Storage-only shape. Sensitive fields are null in `values` and sealed in the envelope. */
export interface WorkflowHumanInputSubmissionRow extends Omit<
  WorkflowHumanInputSubmission,
  "sensitiveValuesExpired"
> {
  encryptedSensitiveValues?: EncryptedContentEnvelopeV1
  sensitiveExpiresAt?: number
  sensitiveValuesExpired?: true
}

/** Encrypted durable file promoted from the companion upload quarantine. */
export interface WorkflowHumanInputFileRow {
  id: string
  accountId: string
  requestId: string
  responderId: string
  fieldId: string
  name: string
  mediaType: string
  size: number
  hash: string
  envelope: {
    version: "cognia-account-artifact/v1"
    algorithm: "AES-GCM"
    iv: Uint8Array
    ciphertext: Uint8Array
  }
  createdAt: number
  expiresAt: number
}

export interface HumanInputActor {
  id: string
  groupIds?: string[]
  isInitiator?: boolean
}

export type HumanInputSubmissionResult =
  | {
      ok: true
      request: WorkflowHumanInputRequest
      submission: WorkflowHumanInputSubmission
      completed: boolean
    }
  | {
      ok: false
      reason:
        | "not-found"
        | "not-pending"
        | "not-assigned"
        | "already-submitted"
        | "invalid-action"
        | "invalid-values"
      message?: string
    }
