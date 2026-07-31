import type { EvalExperimentState, EvalTask, EvalTaskState } from "@cognia/eval-core"

export interface EvalTaskExecutionResult<T = unknown> {
  actualCost: number
  value: T
}

export interface EvalOrchestratorRepository<T = unknown> {
  getExperiment(id: string): Promise<{ state: EvalExperimentState; hardCap: number } | undefined>
  listTasks(experimentId: string): Promise<Array<EvalTask & { providerId?: string }>>
  setExperimentState(
    id: string,
    state: EvalExperimentState,
    details?: { pauseReason?: "user" | "budget" | "rate-limit" | "recovery"; failure?: string }
  ): Promise<void>
  updateTask(id: string, patch: Partial<EvalTask> & { lastError?: string }): Promise<void>
  reserveTask(taskId: string, worstCaseCost: number): Promise<boolean>
  completeTask(task: EvalTask, result: EvalTaskExecutionResult<T>): Promise<void>
  releaseTaskReservation(taskId: string): Promise<void>
  /** Persist adaptive follow-up tasks or the terminal recommendation. */
  prepareNextStage?(experimentId: string): Promise<boolean>
}

export interface EvalRetryDecision {
  retryable: boolean
  retryAfterMs?: number
  reason: string
}

type ErrorWithStatus = Error & {
  status?: number
  statusCode?: number
  retryAfter?: number | string
}

export function classifyEvalRetry(error: unknown): EvalRetryDecision {
  const candidate = error as Partial<ErrorWithStatus>
  const status = candidate.status ?? candidate.statusCode
  const retryAfter = Number(candidate.retryAfter)
  if (status === 429 || status === 408 || (typeof status === "number" && status >= 500)) {
    return {
      retryable: true,
      ...(Number.isFinite(retryAfter) && retryAfter >= 0
        ? { retryAfterMs: retryAfter * 1_000 }
        : {}),
      reason: candidate.message ?? `HTTP ${status}`,
    }
  }
  if (error instanceof TypeError) {
    return { retryable: true, reason: error.message }
  }
  return {
    retryable: false,
    reason: candidate.message ?? String(error),
  }
}

export interface EvalOrchestratorOptions {
  providerConcurrency?: Record<string, number>
  maxAttempts?: number
  baseRetryMs?: number
  now?: () => number
  random?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

const TERMINAL_TASK_STATES = new Set<EvalTaskState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
])

export class DurableEvalOrchestrator<T = unknown> {
  private readonly activeControllers = new Map<string, AbortController>()

  private readonly options: Required<Omit<EvalOrchestratorOptions, "providerConcurrency">> & {
    providerConcurrency: Record<string, number>
  }

  constructor(
    private readonly repository: EvalOrchestratorRepository<T>,
    private readonly execute: (
      task: EvalTask & { providerId?: string },
      signal: AbortSignal
    ) => Promise<EvalTaskExecutionResult<T>>,
    options: EvalOrchestratorOptions = {}
  ) {
    this.options = {
      providerConcurrency: options.providerConcurrency ?? {},
      maxAttempts: options.maxAttempts ?? 3,
      baseRetryMs: options.baseRetryMs ?? 500,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      sleep:
        options.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    }
  }

  async pause(experimentId: string): Promise<void> {
    await this.repository.setExperimentState(experimentId, "paused", { pauseReason: "user" })
  }

  async resume(experimentId: string): Promise<void> {
    await this.repository.setExperimentState(experimentId, "queued")
    await this.run(experimentId)
  }

  async cancel(experimentId: string): Promise<void> {
    const tasks = await this.repository.listTasks(experimentId)
    for (const task of tasks) this.activeControllers.get(task.id)?.abort()
    for (const task of tasks.filter((item) => !TERMINAL_TASK_STATES.has(item.state))) {
      await this.repository.updateTask(task.id, {
        state: "cancelled",
        updatedAt: this.options.now(),
      })
      await this.repository.releaseTaskReservation(task.id)
    }
    await this.repository.setExperimentState(experimentId, "cancelled")
  }

  async run(experimentId: string): Promise<void> {
    const initial = await this.repository.getExperiment(experimentId)
    if (!initial) throw new Error(`Evaluation experiment ${experimentId} not found`)
    if (["completed", "cancelled", "failed"].includes(initial.state)) return
    await this.repository.setExperimentState(experimentId, "running")

    while (true) {
      const experiment = await this.repository.getExperiment(experimentId)
      if (!experiment) throw new Error(`Evaluation experiment ${experimentId} not found`)
      if (experiment.state === "paused" || experiment.state === "cancelled") return

      const tasks = await this.repository.listTasks(experimentId)
      const unfinished = tasks.filter((task) => !TERMINAL_TASK_STATES.has(task.state))
      if (!unfinished.length) {
        if (
          tasks.length > 0 &&
          tasks.every((task) => task.state === "completed") &&
          (await this.repository.prepareNextStage?.(experimentId))
        ) {
          continue
        }
        const terminalState: EvalExperimentState = tasks.some((task) => task.state === "failed")
          ? "failed"
          : tasks.some((task) => task.state === "interrupted")
            ? "interrupted"
            : tasks.some((task) => task.state === "cancelled")
              ? "cancelled"
              : "completed"
        await this.repository.setExperimentState(experimentId, terminalState)
        return
      }

      const now = this.options.now()
      const ready = unfinished.filter(
        (task) => task.state === "queued" && (task.nextAttemptAt ?? 0) <= now
      )
      if (!ready.length) {
        const nextAttempt = Math.min(
          ...unfinished
            .filter((task) => task.state === "queued" && task.nextAttemptAt !== undefined)
            .map((task) => task.nextAttemptAt as number)
        )
        if (!Number.isFinite(nextAttempt)) {
          await this.repository.setExperimentState(experimentId, "interrupted", {
            pauseReason: "recovery",
          })
          return
        }
        await this.options.sleep(Math.max(0, nextAttempt - now))
        continue
      }

      const providerCounts = new Map<string, number>()
      const batch: Array<EvalTask & { providerId?: string }> = []
      for (const task of ready) {
        const providerId = task.providerId ?? "unknown"
        const limit = Math.max(1, this.options.providerConcurrency[providerId] ?? 2)
        const count = providerCounts.get(providerId) ?? 0
        if (count >= limit) continue
        const reserved = await this.repository.reserveTask(
          task.id,
          Math.max(0, task.estimatedWorstCaseCost ?? task.reservedCost)
        )
        if (!reserved) continue
        task.reservedCost = Math.max(task.reservedCost, task.estimatedWorstCaseCost ?? 0)
        batch.push(task)
        providerCounts.set(providerId, count + 1)
      }

      if (!batch.length) {
        await this.repository.setExperimentState(experimentId, "paused", { pauseReason: "budget" })
        return
      }
      await Promise.all(batch.map((task) => this.dispatch(task)))
    }
  }

  private async dispatch(task: EvalTask & { providerId?: string }): Promise<void> {
    const controller = new AbortController()
    this.activeControllers.set(task.id, controller)
    const attempt = task.attempt + 1
    await this.repository.updateTask(task.id, {
      state: "running",
      attempt,
      nextAttemptAt: undefined,
      updatedAt: this.options.now(),
    })
    try {
      const result = await this.execute({ ...task, attempt, state: "running" }, controller.signal)
      await this.repository.completeTask({ ...task, attempt, state: "running" }, result)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const experiment = await this.repository.getExperiment(task.experimentId)
        if (experiment?.state === "cancelled") {
          await this.repository.updateTask(task.id, {
            state: "cancelled",
            updatedAt: this.options.now(),
            lastError: error.message,
          })
          await this.repository.releaseTaskReservation(task.id)
          return
        }
        await this.repository.updateTask(task.id, {
          state: "interrupted",
          updatedAt: this.options.now(),
          lastError: error.message,
        })
        return
      }
      const decision = classifyEvalRetry(error)
      if (decision.retryable && attempt < this.options.maxAttempts) {
        const exponential = this.options.baseRetryMs * 2 ** (attempt - 1)
        const jitter = 0.5 + this.options.random()
        const delay = decision.retryAfterMs ?? Math.round(exponential * jitter)
        await this.repository.updateTask(task.id, {
          state: "queued",
          attempt,
          nextAttemptAt: this.options.now() + delay,
          updatedAt: this.options.now(),
          lastError: decision.reason,
        })
        return
      }
      await this.repository.updateTask(task.id, {
        state: "failed",
        attempt,
        updatedAt: this.options.now(),
        lastError: decision.reason,
      })
      await this.repository.releaseTaskReservation(task.id)
    } finally {
      this.activeControllers.delete(task.id)
    }
  }
}
