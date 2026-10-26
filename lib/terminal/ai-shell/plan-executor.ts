/**
 * Plan executor for the AI Shell.
 *
 * Runs an execution plan step by step — writes each command to the PTY,
 * waits for a real command completion event (or fails on timeout),
 * records the exit code, and pauses on failure for user decision.
 *
 * Design notes:
 *  - Uses the `AiShellSession` contract to decouple from xterm internals
 *  - Each step waits for `command_end` or a configurable timeout
 *  - On failure (non-zero exit), execution pauses — caller decides next action
 *  - Abort signal can cancel mid-run
 */

import type {
  ExecutionPlan,
  ExecutionStep,
  StepStatus,
  StepProgressCallback,
  PlanExecutorOptions,
  AiShellSession,
} from "./types"

/** Default per-step timeout in ms. */
export const DEFAULT_STEP_TIMEOUT_MS = 60_000

/** Bounded wait for a real command-end after requesting a foreground interrupt. */
export const INTERRUPT_ACK_TIMEOUT_MS = 2_000

/** Result from executing a single step. */
export interface StepResult {
  index: number
  status: StepStatus
  exitCode: number | null
  outputSnippet: string | null
  /** No real completion was observed; writing further input may be unsafe. */
  unconfirmed?: boolean
}

/** Result from running the entire plan. */
export interface PlanExecutionResult {
  /** The final plan status. */
  completedSteps: number
  /** Total steps in the plan. */
  totalSteps: number
  /** Whether the plan ran to completion without failures. */
  allSucceeded: boolean
  /** Index of the first failed step, or -1 if none failed. */
  firstFailedStep: number
  /** Updated step statuses. */
  steps: StepResult[]
}

/**
 * Execute a single step: write the command to PTY, wait for completion.
 *
 * @returns The result of executing this step.
 */
export async function executeStep(
  step: ExecutionStep,
  session: AiShellSession,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<StepResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const signal = options?.signal

  if (signal?.aborted) {
    return { index: step.index, status: "cancelled", exitCode: null, outputSnippet: null }
  }

  return new Promise<StepResult>((resolve) => {
    let settled = false
    let interrupting: StepStatus | null = null
    let interruptAccepted = false
    let completionSeen = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubCommandEnd: (() => void) | null = null
    let unsubAbort: (() => void) | null = null

    const finish = (status: StepStatus, exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubCommandEnd?.()
      unsubAbort?.()
      const outputSnippet = status === "failed" ? session.getRecentOutput(20) : null
      resolve({
        index: step.index,
        status,
        exitCode,
        outputSnippet,
        ...(status === "failed" && !completionSeen ? { unconfirmed: true } : {}),
      })
    }

    const interrupt = (status: StepStatus) => {
      if (settled || interrupting) return
      interrupting = status
      if (timer) clearTimeout(timer)
      unsubAbort?.()
      // Sending ETX requests a foreground interrupt without destroying the
      // shell. Retain completion observation: transport acceptance alone does
      // not establish that the process stopped (it may ignore SIGINT).
      timer = setTimeout(() => finish("failed", null), INTERRUPT_ACK_TIMEOUT_MS)
      Promise.resolve()
        .then(() => session.write("\u0003"))
        .then(
          () => {
            interruptAccepted = true
            if (completionSeen) finish(status, null)
          },
          () => finish("failed", null)
        )
    }

    unsubCommandEnd = session.onCommandEnd((exitCode) => {
      completionSeen = true
      if (interrupting) {
        if (interruptAccepted) finish(interrupting, null)
      } else {
        finish(exitCode === 0 ? "succeeded" : "failed", exitCode)
      }
    })
    if (settled) {
      unsubCommandEnd()
      return
    }

    if (signal) {
      const onAbort = () => interrupt("cancelled")
      signal.addEventListener("abort", onAbort, { once: true })
      unsubAbort = () => signal.removeEventListener("abort", onAbort)
    }

    timer = setTimeout(() => interrupt("failed"), timeoutMs)
    try {
      Promise.resolve(session.write(step.command + "\r")).catch(() => finish("failed", null))
    } catch {
      finish("failed", null)
    }
  })
}

/**
 * Execute a plan step by step. Pauses on the first failure and returns.
 *
 * @param plan - The plan to execute (steps array is read, not mutated)
 * @param session - The terminal session to write commands to
 * @param options - Execution options (timeout, abort, autoConfirm)
 * @param onProgress - Callback fired as each step's status changes
 * @returns The final execution result
 */
export async function executePlan(
  plan: ExecutionPlan,
  session: AiShellSession,
  options?: PlanExecutorOptions,
  onProgress?: StepProgressCallback
): Promise<PlanExecutionResult> {
  const timeoutMs = options?.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const signal = options?.signal
  const results: StepResult[] = []

  for (const [position, step] of plan.steps.entries()) {
    // Check abort before each step
    if (signal?.aborted) {
      results.push({ index: step.index, status: "cancelled", exitCode: null, outputSnippet: null })
      onProgress?.(step.index, "cancelled", null, null)
      // Mark remaining steps as cancelled
      for (const remaining of plan.steps.slice(position + 1)) {
        results.push({
          index: remaining.index,
          status: "cancelled",
          exitCode: null,
          outputSnippet: null,
        })
        onProgress?.(remaining.index, "cancelled", null, null)
      }
      break
    }

    // Skip already-completed steps (for resume scenarios)
    if (step.status === "succeeded" || step.status === "skipped") {
      results.push({
        index: step.index,
        status: step.status,
        exitCode: step.exitCode,
        outputSnippet: null,
      })
      continue
    }

    // Notify progress: step is running
    onProgress?.(step.index, "running", null, null)

    // Execute
    const result = await executeStep(step, session, { timeoutMs, signal })
    results.push(result)
    onProgress?.(result.index, result.status, result.exitCode, result.outputSnippet)

    // On failure, stop execution (caller decides what to do)
    if (result.status === "failed") {
      // Mark remaining steps as pending (not cancelled — user may retry)
      for (const remaining of plan.steps.slice(position + 1)) {
        results.push({
          index: remaining.index,
          status: "pending",
          exitCode: null,
          outputSnippet: null,
        })
      }
      break
    }

    if (result.status === "cancelled") {
      for (const remaining of plan.steps.slice(position + 1)) {
        results.push({
          index: remaining.index,
          status: "cancelled",
          exitCode: null,
          outputSnippet: null,
        })
        onProgress?.(remaining.index, "cancelled", null, null)
      }
      break
    }
  }

  const completedSteps = results.filter(
    (r) => r.status === "succeeded" || r.status === "skipped"
  ).length
  const firstFailed = results.findIndex((r) => r.status === "failed")

  return {
    completedSteps,
    totalSteps: plan.steps.length,
    allSucceeded: completedSteps === plan.steps.length,
    firstFailedStep: firstFailed === -1 ? -1 : results[firstFailed].index,
    steps: results,
  }
}
