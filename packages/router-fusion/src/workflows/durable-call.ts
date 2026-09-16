/**
 * One logical model call, executed durably (DESIGN §13.3–§13.4, §25.2, §25.5).
 *
 * Each transport attempt reserves its own money and consumes one model-call
 * slot, is committed DISPATCHED before it is sent, and settles exactly once.
 * Retries are bounded by `transport_attempts_per_call` and only follow an
 * explicit "not accepted" answer (429, a server error, a connect failure that
 * never sent). A request that was sent and never answered becomes UNKNOWN and
 * is never retried or assumed free. A policy refusal is not a transport error:
 * it ends the call and is never routed around (CAS-04).
 */

import { canonicalHash } from "../util/sha256"
import type {
  CallLedgerPort,
  Clock,
  CommittedCallResult,
  EventSink,
  RoleCallExecutor,
  RoleCallRequest,
  RoleCallResponse,
} from "./ports"

export class WorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "WorkflowError"
  }
}

export class BudgetRefusedError extends WorkflowError {
  constructor(refusal: string) {
    super(refusal, `call refused by the ledger: ${refusal}`, { refusal })
    this.name = "BudgetRefusedError"
  }
}

export class PolicyRefusalError extends WorkflowError {
  constructor(message: string) {
    super("POLICY_REFUSAL", message)
    this.name = "PolicyRefusalError"
  }
}

export class CallOutcomeUnknownError extends WorkflowError {
  constructor(attemptId: string) {
    super("CALL_OUTCOME_UNKNOWN", `call ${attemptId} was sent and its outcome is unknown`, {
      attemptId,
    })
    this.name = "CallOutcomeUnknownError"
  }
}

export class CallFailedError extends WorkflowError {
  constructor(errorClass: string, message: string) {
    super("CALL_FAILED", message, { errorClass })
    this.name = "CallFailedError"
  }
}

export interface DurableCallPorts {
  ledger: CallLedgerPort
  executor: RoleCallExecutor
  events: EventSink
  clock: Clock
  /** Waits between retries; tests pass an instant sleep. */
  sleep: (ms: number) => Promise<void>
}

export interface DurableCallInput {
  runId: string
  logicalStepId: string
  role: string
  deploymentId: string
  reserveMicrousd: number
  fromStageId?: string
  transportAttempts: number
  deadlineAt: number
  request: Omit<RoleCallRequest, "attemptId" | "runId" | "logicalStepId" | "role" | "deploymentId">
  signal: AbortSignal
}

export interface DurableCallResult extends CommittedCallResult {
  replayed: boolean
  attempts: number
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

const RETRYABLE = new Set(["rate_limited", "server_error", "not_sent"])

export async function performDurableCall(
  ports: DurableCallPorts,
  input: DurableCallInput
): Promise<DurableCallResult> {
  const requestHash = canonicalHash({
    step: input.logicalStepId,
    deployment: input.deploymentId,
    messages: input.request.messages,
    maxOutputTokens: input.request.maxOutputTokens,
    jsonSchema: input.request.jsonSchema ?? null,
    tools: input.request.toolPolicyId,
  })
  let lastError: RoleCallResponse | null = null

  for (let attempt = 1; attempt <= input.transportAttempts; attempt++) {
    if (input.signal.aborted) throw new WorkflowError("CANCELLED", "the run was cancelled")
    if (ports.clock.now() >= input.deadlineAt)
      throw new WorkflowError("DEADLINE_EXCEEDED", "the run deadline passed")

    const prepareInput = {
      logicalStepId: input.logicalStepId,
      role: input.role,
      deploymentId: input.deploymentId,
      reserveMicrousd: input.reserveMicrousd,
      requestHash,
    }
    const stageId = attempt === 1 ? input.fromStageId : undefined
    let prepared = await ports.ledger.prepare(
      stageId ? { ...prepareInput, fromStageId: stageId } : prepareInput
    )
    // The stage was already spent or released (a replay after recovery): the
    // call reserves its own money like any other, or is refused like any other.
    if (stageId && prepared.kind === "refused" && prepared.code === "STAGE_NOT_HELD") {
      prepared = await ports.ledger.prepare(prepareInput)
    }
    if (prepared.kind === "replay") {
      return { ...prepared.result, replayed: true, attempts: 0 }
    }
    if (prepared.kind === "refused") {
      if (prepared.code === "STEP_OUTCOME_UNKNOWN") {
        throw new CallOutcomeUnknownError(`step:${input.logicalStepId}`)
      }
      throw new BudgetRefusedError(prepared.code)
    }

    await ports.ledger.markDispatched(prepared.attemptId)
    await ports.events.emit({
      type: "call.started",
      payload: {
        logical_step_id: input.logicalStepId,
        role: input.role,
        deployment_id: input.deploymentId,
        attempt: prepared.attemptNo,
      },
    })

    let response: RoleCallResponse
    try {
      response = await ports.executor.call(
        {
          ...input.request,
          runId: input.runId,
          logicalStepId: input.logicalStepId,
          attemptId: prepared.attemptId,
          role: input.role,
          deploymentId: input.deploymentId,
        },
        input.signal
      )
    } catch (error) {
      // An adapter that throws gives no proof the request was not sent.
      await ports.ledger.markUnknown(
        prepared.attemptId,
        error instanceof Error ? error.message : String(error)
      )
      await ports.events.emit({
        type: "call.finished",
        payload: { logical_step_id: input.logicalStepId, status: "unknown" },
      })
      throw new CallOutcomeUnknownError(prepared.attemptId)
    }

    if (response.outcome === "ok") {
      const result: CommittedCallResult = {
        text: response.text,
        providerRequestId: response.providerRequestId,
        finishReason: response.finishReason,
      }
      const settled = await ports.ledger.settle(prepared.attemptId, {
        status: "succeeded",
        usage: response.usage,
        semantics: response.semantics,
        providerRequestId: response.providerRequestId,
        result,
      })
      await ports.events.emit({
        type: "call.finished",
        payload: {
          logical_step_id: input.logicalStepId,
          status: "succeeded",
          cost_microusd: settled.actualMicrousd,
          cost_status: settled.costStatus,
        },
      })
      return {
        ...result,
        replayed: false,
        attempts: attempt,
        ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
      }
    }

    lastError = response
    if (
      response.errorClass === "timeout_after_send" ||
      (response.errorClass === "cancelled" && response.usage === undefined)
    ) {
      if (response.errorClass === "cancelled") {
        // A cancellation that interrupted an in-flight request cannot prove the request went unbilled.
        await ports.ledger.markUnknown(prepared.attemptId, "cancelled in flight")
        throw new WorkflowError("CANCELLED", "the run was cancelled")
      }
      await ports.ledger.markUnknown(prepared.attemptId, response.message)
      await ports.events.emit({
        type: "call.finished",
        payload: { logical_step_id: input.logicalStepId, status: "unknown" },
      })
      throw new CallOutcomeUnknownError(prepared.attemptId)
    }

    // An explicit rejection (429, 5xx, connection refused) settles as a failed
    // attempt: it keeps its model-call slot and books whatever usage came back.
    await ports.ledger.settle(prepared.attemptId, {
      status: "failed",
      usage: response.usage ?? null,
      semantics: response.semantics ?? null,
      providerRequestId: response.providerRequestId ?? null,
      errorClass: response.errorClass,
    })
    await ports.events.emit({
      type: "call.finished",
      payload: {
        logical_step_id: input.logicalStepId,
        status: "failed",
        error_class: response.errorClass,
      },
    })

    if (response.errorClass === "refusal") throw new PolicyRefusalError(response.message)
    if (response.errorClass === "cancelled")
      throw new WorkflowError("CANCELLED", "the run was cancelled")
    if (!RETRYABLE.has(response.errorClass))
      throw new CallFailedError(response.errorClass, response.message)
    if (attempt < input.transportAttempts) {
      const wait = Math.max(0, response.retryAfterMs ?? 0)
      if (ports.clock.now() + wait >= input.deadlineAt) break
      if (wait > 0) await ports.sleep(wait)
    }
  }

  const failure = lastError && lastError.outcome === "error" ? lastError : null
  throw new CallFailedError(
    failure?.errorClass ?? "unknown",
    failure?.message ?? "transport attempts exhausted"
  )
}
