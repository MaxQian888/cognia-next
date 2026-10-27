/** A run-owned abort scope. The timer bounds evaluation, not the Squad config. */
export function createEvalDeadline(parent?: AbortSignal, timeoutMs?: number) {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener("abort", onParentAbort, { once: true })
  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          const error = new Error("Evaluation deadline exceeded")
          error.name = "TimeoutError"
          controller.abort(error)
        }, timeoutMs)
      : undefined
  return {
    signal:
      timeoutMs !== undefined && timeoutMs > 0 ? controller.signal : (parent ?? controller.signal),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted()
      let rejectAbort!: (reason: unknown) => void
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject
      })
      const onAbort = () => rejectAbort(controller.signal.reason)
      controller.signal.addEventListener("abort", onAbort, { once: true })
      try {
        const result = await Promise.race([operation(), aborted])
        controller.signal.throwIfAborted()
        return result
      } finally {
        controller.signal.removeEventListener("abort", onAbort)
      }
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      parent?.removeEventListener("abort", onParentAbort)
    },
  }
}
