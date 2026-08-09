/**
 * Plan executor for the AI Shell.
 *
 * Runs an execution plan step by step — writes each command to the PTY,
 * waits for the command to complete (via OSC 633 events or timeout fallback),
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

/** Result from executing a single step. */
export interface StepResult {
  index: number
  status: StepStatus
  exitCode: number | null
  outputSnippet: string | null
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
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubCommandEnd: (() => void) | null = null
    let unsubAbort: (() => void) | null = null

    const settle = (status: StepStatus, exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubCommandEnd?.()
      unsubAbort?.()
      const outputSnippet = status === "failed" ? session.getRecentOutput(20) : null
      resolve({ index: step.index, status, exitCode, outputSnippet })
    }

    // Arm the command-end listener before writing to avoid race
    unsubCommandEnd = session.onCommandEnd((exitCode) => {
      settle(exitCode === 0 ? "succeeded" : "failed", exitCode)
    })

    // Abort handler
    if (signal) {
      const onAbort = () => settle("cancelled", null)
      signal.addEventListener("abort", onAbort, { once: true })
      unsubAbort = () => signal.removeEventListener("abort", onAbort)
    }

    // Timeout fallback
    timer = setTimeout(() => {
      // If we hit the timeout, treat it as a failure — the command is likely
      // stuck or the shell didn't emit OSC 633 command_end.
      settle("failed", null)
    }, timeoutMs)

    // Write the command to the PTY (with \r to submit)
    session.write(step.command + "\r")
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

  for (const step of plan.steps) {
    // Check abort before each step
    if (signal?.aborted) {
      results.push({ index: step.index, status: "cancelled", exitCode: null, outputSnippet: null })
      onProgress?.(step.index, "cancelled", null, null)
      // Mark remaining steps as cancelled
      for (let i = step.index + 1; i < plan.steps.length; i++) {
        results.push({ index: i, status: "cancelled", exitCode: null, outputSnippet: null })
        onProgress?.(i, "cancelled", null, null)
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
      for (let i = step.index + 1; i < plan.steps.length; i++) {
        results.push({ index: i, status: "pending", exitCode: null, outputSnippet: null })
      }
      break
    }

    if (result.status === "cancelled") {
      for (let i = step.index + 1; i < plan.steps.length; i++) {
        results.push({ index: i, status: "cancelled", exitCode: null, outputSnippet: null })
        onProgress?.(i, "cancelled", null, null)
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
    firstFailedStep: firstFailed,
    steps: results,
  }
}
