const RECONNECT_BACKOFF_MS = [250, 1_000, 4_000, 16_000, 30_000] as const

/** Shared CLI reconnect schedule with bounded positive jitter. */
export function reconnectDelayMs(attempt: number, random = Math.random()): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), RECONNECT_BACKOFF_MS.length - 1)
  return Math.round(RECONNECT_BACKOFF_MS[index] * (0.5 + Math.max(0, Math.min(1, random)) * 0.5))
}

export function waitForReconnectDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("reconnect cancelled"))
      return
    }
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error("reconnect cancelled"))
      },
      { once: true }
    )
  })
}
