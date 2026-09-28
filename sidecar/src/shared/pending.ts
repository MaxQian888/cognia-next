export interface PendingEntry<T> {
  resolve(value: T): void
  reject?(error: unknown): void
}
export interface PendingOptions<T, Extra extends object> {
  extra?: Extra
  timeoutMs?: number
  ref?: boolean
  exposeReject?: boolean
  onTimeout?: () => T
  onSettled?: () => void
  mapAnswer?: (value: T) => T
}

/** Register synchronously, then own the timer and once-only settlement. */
export function awaitPending<T, Extra extends object = object>(
  pending: Map<string, PendingEntry<T> & Extra>,
  id: string,
  options: PendingOptions<T, Extra> = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pending.get(id) === entry) pending.delete(id)
      options.onSettled?.()
      complete()
    }
    const rejectEntry = (error: unknown) => finish(() => reject(error))
    const entry = {
      resolve(value: T) {
        finish(() => {
          try {
            resolve(options.mapAnswer ? options.mapAnswer(value) : value)
          } catch (error) {
            reject(error)
          }
        })
      },
      ...options.extra,
      ...(options.exposeReject ? { reject: rejectEntry } : {}),
    } as PendingEntry<T> & Extra
    pending.set(id, entry)
    if (options.timeoutMs !== undefined && options.onTimeout) {
      timer = setTimeout(() => {
        try {
          entry.resolve(options.onTimeout!())
        } catch (error) {
          rejectEntry(error)
        }
      }, options.timeoutMs)
      if (options.ref === false) timer.unref()
    }
  })
}

export function settlePending<T>(
  pending: Map<string, PendingEntry<T>>,
  id: string,
  value: T
): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  entry.resolve(value)
  return true
}

/** Drain even when a foreign resolver throws; remove before invoking it. */
export function drainPending<T>(
  pending: Map<string, PendingEntry<T>> | undefined,
  value: T,
  beforeResolve?: (id: string) => void
) {
  if (!pending) return
  for (const [id, entry] of pending) {
    pending.delete(id)
    try {
      beforeResolve?.(id)
    } catch {
      /* notifications cannot block cleanup */
    }
    try {
      entry.resolve(value)
    } catch {
      /* a foreign resolver cannot block other waiters */
    }
  }
}
