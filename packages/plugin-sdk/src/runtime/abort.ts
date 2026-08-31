/** Merge abort signals without retaining listeners after the caller is done. */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): { signal: AbortSignal; cleanup: () => void } | undefined {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (live.length === 0) return undefined
  if (live.length === 1) return { signal: live[0], cleanup: () => undefined }

  const controller = new AbortController()
  const onAbort = () => controller.abort()

  if (live.some((signal) => signal.aborted)) {
    controller.abort()
    return { signal: controller.signal, cleanup: () => undefined }
  }

  for (const signal of live) signal.addEventListener("abort", onAbort, { once: true })
  const cleanup = () => {
    for (const signal of live) {
      try {
        signal.removeEventListener("abort", onAbort)
      } catch {
        // Some AbortSignal shims do not implement listener removal.
      }
    }
  }
  return { signal: controller.signal, cleanup }
}
