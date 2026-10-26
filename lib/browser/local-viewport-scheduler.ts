export interface LocalViewport {
  width: number
  height: number
  deviceScaleFactor: number
  fitToWidth: boolean
}

export interface LocalViewportResult {
  frameSequence?: number
}

interface SchedulerOptions {
  sessionId: string
  resize: (
    viewport: LocalViewport,
    synchronizeFrame: boolean
  ) => Promise<LocalViewportResult | void>
  onRequest?: (viewport: LocalViewport) => void
  onApplied?: (viewport: LocalViewport, result: LocalViewportResult | void) => void
  onError?: (error: unknown) => void
  intervalMs?: number
}

// A preview can unmount while its RPC is still running. Keep only unsettled
// work here so its replacement waits without retaining closed sessions.
const sessionTails = new Map<string, Promise<void>>()
const MAX_RETRIES = 3

function equalViewport(left: LocalViewport | null, right: LocalViewport | null): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.width === right.width &&
      left.height === right.height &&
      left.deviceScaleFactor === right.deviceScaleFactor &&
      left.fitToWidth === right.fitToWidth)
  )
}

/** Latest-wins viewport work, serialized across every preview of a session. */
export function createLocalViewportScheduler({
  sessionId,
  resize,
  onRequest,
  onApplied,
  onError,
  intervalMs = 50,
}: SchedulerOptions) {
  let desired: LocalViewport | null = null
  let applied: LocalViewport | null = null
  let disposed = false
  let busy = false
  let synchronized = false
  let revision = 0
  let failures = 0
  let nextDispatchAt = 0
  let retryAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    if (disposed || busy || timer !== undefined || !desired || failures > MAX_RETRIES) return
    if (equalViewport(desired, applied)) return
    const delay = Math.max(nextDispatchAt, retryAt) - Date.now()
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = undefined
        schedule()
      }, delay)
      return
    }
    busy = true
    const work = (sessionTails.get(sessionId) ?? Promise.resolve()).then(async () => {
      // Read at dispatch rather than enqueue: a blocked successor must use
      // its latest dimensions and must not run after its preview disappears.
      if (disposed || !desired || equalViewport(desired, applied)) return
      const viewport = desired
      const requestRevision = revision
      nextDispatchAt = Date.now() + intervalMs
      try {
        onRequest?.(viewport)
        if (disposed || !desired) return
        // An RPC can change Chromium's viewport before a later step rejects.
        // Its previous successful dimensions are no longer safe to skip.
        applied = null
        const result = await resize(viewport, !synchronized)
        if (disposed) return
        synchronized = true
        applied = viewport
        if (requestRevision === revision) failures = 0
        if (desired) onApplied?.(viewport, result)
      } catch (error) {
        if (disposed || !desired || requestRevision !== revision) return
        failures += 1
        retryAt = Date.now() + 50 * 2 ** (failures - 1)
        if (failures === 1) onError?.(error)
      }
    })
    const tail = work.catch(() => undefined)
    sessionTails.set(sessionId, tail)
    void tail.then(() => {
      if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId)
      busy = false
      schedule()
    })
  }

  return {
    update(viewport: LocalViewport | null) {
      if (disposed || equalViewport(desired, viewport)) return
      desired = viewport ? { ...viewport } : null
      revision += 1
      failures = 0
      retryAt = 0
      // Recompute an obsolete retry delay without moving the fixed throttle
      // deadline. Continuous measurements still share the same send window.
      clearTimeout(timer)
      timer = undefined
      schedule()
    },
    dispose() {
      disposed = true
      desired = null
      clearTimeout(timer)
      timer = undefined
    },
  }
}
