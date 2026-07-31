/**
 * Generic worker pool for concurrent async task execution.
 *
 * Workers pull tasks from a shared atomic index, avoiding the complexity
 * and deadlock risks of Promise.race + Set semaphore patterns.
 * Results are stored at their input index, preserving call order.
 *
 * Supports:
 * - Fixed-size worker pool
 * - Overall timeout protection (graceful — returns partial results)
 * - Max task limit
 * - Per-task completion callback
 */

export interface PoolOptions {
  /** Maximum number of concurrent workers */
  concurrency: number
  /** Maximum number of tasks to process (optional) */
  maxTasks?: number
  /** Overall timeout in milliseconds (optional). On timeout, workers stop
   *  starting new tasks and the pool returns whatever results are ready. */
  timeoutMs?: number
}

/**
 * Execute a list of async tasks with a fixed-size worker pool.
 *
 * Workers pull from a shared index counter, so the system stays
 * busy even if some tasks take longer than others. Results are
 * stored at their input position, preserving the original order.
 *
 * On timeout, the pool **does not reject** — instead it sets a flag
 * that stops idle workers, waits for in-flight workers to finish their
 * current task, and returns whatever results have been collected so far.
 *
 * @param tasks - Array of async task factories
 * @param options - Pool configuration
 * @param onTaskComplete - Optional callback after each task completes
 * @returns Results array in input order (gaps for tasks that were not started)
 */
export async function runPool<T>(
  tasks: (() => Promise<T>)[],
  options: PoolOptions,
  onTaskComplete?: (result: T, index: number, completedCount: number) => void
): Promise<T[]> {
  const total = tasks.length
  const maxConcurrent = Math.max(1, Math.min(options.concurrency, total))
  const results: T[] = new Array(total)
  let nextIndex = 0
  let completedCount = 0
  let timedOut = false

  const worker = async (): Promise<void> => {
    while (true) {
      if (timedOut) break
      // Atomically get the next task index
      const idx = nextIndex++
      if (idx >= total) break
      // Stop if over the max task limit (don't waste CPU on continue)
      if (options.maxTasks !== undefined && idx >= options.maxTasks) break

      const result = await tasks[idx]()
      results[idx] = result
      completedCount++
      onTaskComplete?.(result, idx, completedCount)
    }
  }

  const workers = Array.from({ length: maxConcurrent }, () => worker())

  if (options.timeoutMs && options.timeoutMs > 0) {
    // Timeout handler: set the flag so workers stop picking new tasks,
    // then resolve (not reject) so the caller gets partial results.
    const timeoutGuard = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true
        resolve()
      }, options.timeoutMs)
    })
    await Promise.race([Promise.all(workers), timeoutGuard])
    // If timeout fired, the timedOut flag is already set. Workers that are
    // in-flight will complete their current task naturally and then stop.
    // Wait a brief moment for those in-flight tasks to settle.
    if (timedOut) {
      await Promise.all(workers)
    }
  } else {
    await Promise.all(workers)
  }

  return results
}
