/** Incremental composer jobs share two engine slots across mounted panes. */
let running = 0
const waiting: Array<() => void> = []

export function runAttachmentProcessing<T>(job: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = false
    const abort = () => {
      if (started) return
      const index = waiting.indexOf(start)
      if (index >= 0) waiting.splice(index, 1)
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const start = () => {
      if (signal.aborted) {
        abort()
        return
      }
      started = true
      signal.removeEventListener("abort", abort)
      running++
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          running--
          waiting.shift()?.()
        })
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    if (running < 2) start()
    else waiting.push(start)
  })
}
