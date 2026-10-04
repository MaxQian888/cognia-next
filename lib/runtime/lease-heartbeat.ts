export interface LeaseHeartbeatOptions {
  renew: () => Promise<"renewed" | "closed" | "lost">
  intervalMs: number
  onLeaseLost?: () => void
  onError?: (error: unknown) => void
}

/** Sequential renewal shared by journal owners; stopping fences late renewals. */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const lost = () => {
    stop()
    options.onLeaseLost?.()
  }
  const tick = async () => {
    try {
      const status = await options.renew()
      if (stopped) return
      if (status === "renewed") schedule()
      else if (status === "lost") lost()
      else stop()
    } catch (error) {
      if (stopped) return
      try {
        options.onError?.(error)
      } finally {
        lost()
      }
    }
  }
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void tick().catch(() => undefined), options.intervalMs)
    // Background bookkeeping must not keep a headless process alive on its own.
    if (typeof timer === "object") timer.unref?.()
  }
  schedule()
  return stop
}
