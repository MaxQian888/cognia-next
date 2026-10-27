// Turn-scoped verification wall accounting, separate from spend/call admission.
// It cannot extend the caller's cancellation deadline or certify task success.
import { performance } from "node:perf_hooks"
import type { ModelMessage, PrepareStepFunction, ToolSet } from "ai"
import type { VerificationBudgetStamp } from "@cognia/agent-config-types/execution-budget"

export function validateVerificationBudgetStamp(stamp?: VerificationBudgetStamp): void {
  if (stamp === undefined || stamp === null) return
  const duration = stamp.deadlineEpochMs - stamp.startedAtEpochMs
  const batch = stamp.maxBatchMs ?? 15_000
  const fraction = stamp.verificationFraction ?? 0.5
  const reserve = stamp.completionReserveMs ?? 15_000
  if (
    ![stamp.deadlineEpochMs, stamp.startedAtEpochMs, duration, batch, fraction, reserve].every(
      Number.isFinite
    ) ||
    duration <= 0 ||
    duration > 86_400_000 ||
    batch < 1 ||
    batch > 120_000 ||
    fraction <= 0 ||
    fraction > 1 ||
    reserve < 0 ||
    reserve > 60_000
  ) {
    throw new Error("Invalid host verification-budget stamp")
  }
}

export function createVerificationBudget(
  clock = {
    epoch: () => Date.now(),
    monotonic: () => performance.now(),
  }
) {
  let enabled = false
  let generation = 0
  let durationMs = 0
  let deadline = 0
  let allowanceMs = 0
  let spentMs = 0
  let batchMaxMs = 15_000
  let reserveMs = 15_000
  const reservations = new Map<symbol, number>()

  function reset(stamp?: VerificationBudgetStamp) {
    generation++
    enabled = false
    reservations.clear()
    spentMs = 0
    durationMs = 0
    allowanceMs = 0
    deadline = 0
    if (stamp === undefined || stamp === null) return
    validateVerificationBudgetStamp(stamp)
    const duration = stamp.deadlineEpochMs - stamp.startedAtEpochMs
    const batch = stamp.maxBatchMs ?? 15_000
    const fraction = stamp.verificationFraction ?? 0.5
    const reserve = stamp.completionReserveMs ?? 15_000
    enabled = true
    durationMs = duration
    deadline =
      clock.monotonic() + Math.max(0, Math.min(duration, stamp.deadlineEpochMs - clock.epoch()))
    allowanceMs = duration * fraction
    batchMaxMs = batch
    reserveMs = Math.min(reserve, duration / 4)
  }

  function snapshot() {
    const remainingMs = enabled ? Math.max(0, deadline - clock.monotonic()) : 0
    const reservedMs = [...reservations.values()].reduce((sum, value) => sum + value, 0)
    const verificationRemainingMs = Math.max(0, allowanceMs - spentMs - reservedMs)
    return {
      enabled,
      generation,
      durationMs,
      remainingMs,
      elapsedMs: enabled ? Math.max(0, durationMs - remainingMs) : 0,
      verificationSpentMs: spentMs,
      verificationRemainingMs,
      completionReserveMs: reserveMs,
      maxBatchMs: batchMaxMs,
      availableBatchMs: enabled
        ? Math.max(0, Math.min(batchMaxMs, verificationRemainingMs, remainingMs - reserveMs))
        : 0,
    }
  }

  function reserveBatch(requestedMs?: number) {
    const available = snapshot().availableBatchMs
    const allocatedMs = Math.floor(Math.min(requestedMs ?? batchMaxMs, available))
    if (!Number.isFinite(allocatedMs) || allocatedMs < 1) return null
    const id = Symbol("verification-batch")
    const ownGeneration = generation
    const started = clock.monotonic()
    reservations.set(id, allocatedMs)
    return {
      generation: ownGeneration,
      allocatedMs,
      current: () => enabled && generation === ownGeneration && reservations.has(id),
      remainingMs: () =>
        generation === ownGeneration && reservations.has(id)
          ? Math.max(
              0,
              Math.min(
                allocatedMs - (clock.monotonic() - started),
                snapshot().remainingMs - reserveMs
              )
            )
          : 0,
      finish() {
        if (generation !== ownGeneration || !reservations.delete(id)) return
        spentMs += Math.max(0, clock.monotonic() - started)
      },
    }
  }

  return { reset, snapshot, reserveBatch }
}

export type VerificationBudget = ReturnType<typeof createVerificationBudget>

export function verificationBudgetFeedback(budget: VerificationBudget): string {
  const value = budget.snapshot()
  const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000))
  return (
    `[Runtime execution budget — host clock]\n` +
    `Elapsed ${seconds(value.elapsedMs)}s; remaining ${seconds(value.remainingMs)}s of ${seconds(value.durationMs)}s. ` +
    `Verification allowance remaining ${seconds(value.verificationRemainingMs)}s; batch limit ${seconds(value.availableBatchMs)}s; completion reserve ${seconds(value.completionReserveMs)}s.\n` +
    `Use verification_batch for small explicit named checks (discover it with ToolSearch if needed). ` +
    `Split long sweeps into bounded batches with incremental results/checkpoints. Preserve every original acceptance requirement; complete core checks before optional exploration. ` +
    `A successful command or batch never proves the whole task complete. Failed, timed-out and unexecuted checks remain incomplete. Report remaining work honestly when the budget cannot fit it.`
  )
}

export function withVerificationFeedback(
  budget: VerificationBudget,
  existing?: PrepareStepFunction<ToolSet>
): PrepareStepFunction<ToolSet> {
  // AI SDK carries message overrides into later steps. Remove only our own
  // previous projection, never a caller's message with matching text.
  const feedbackMessages = new WeakSet<ModelMessage>()
  return async (options) => {
    const cleanInput = options.messages.filter((message) => !feedbackMessages.has(message))
    const prepared = (await existing?.({ ...options, messages: cleanInput })) ?? {}
    const selected = prepared.messages ?? cleanInput
    const messages = selected.filter((message) => !feedbackMessages.has(message))
    if (!budget.snapshot().enabled) {
      return cleanInput.length !== options.messages.length || messages.length !== selected.length
        ? { ...prepared, messages }
        : prepared
    }
    const feedback: ModelMessage = { role: "user", content: verificationBudgetFeedback(budget) }
    feedbackMessages.add(feedback)
    // Keep instructions/tools/history byte-stable. Volatile metadata belongs
    // after the current history, outside the reusable prefix, not in system.
    return { ...prepared, messages: [...messages, feedback] }
  }
}
