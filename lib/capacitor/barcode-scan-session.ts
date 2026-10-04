"use client"

/** A single native preview is shared by pairing and remote workflow scans. */
export interface BarcodeScanSnapshot {
  readonly cancel: () => void
  readonly toggleTorch?: () => void
  readonly torchEnabled: boolean
  readonly torchPending: boolean
  readonly torchError: boolean
}

export class BarcodeScanViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BarcodeScanViewError"
  }
}

const hosts = new Set<symbol>()
const hostWaiters = new Set<() => void>()
const listeners = new Set<() => void>()
let snapshot: BarcodeScanSnapshot | null = null
let activeId: symbol | null = null

function publish(next: BarcodeScanSnapshot | null): void {
  snapshot = next
  for (const listener of listeners) listener()
}

export const getBarcodeScanSnapshot = (): BarcodeScanSnapshot | null => snapshot
export const getBarcodeScanServerSnapshot = (): null => null

export function subscribeBarcodeScanView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function registerBarcodeScanHost(): () => void {
  const id = Symbol("barcode-scan-host")
  hosts.add(id)
  for (const ready of hostWaiters) ready()
  return () => {
    if (hosts.delete(id) && hosts.size === 0) snapshot?.cancel()
  }
}

/** Wait for the mobile-only chunk without starting an invisible camera. */
export function waitForBarcodeScanViewHost(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      hostWaiters.delete(ready)
      signal?.removeEventListener("abort", abort)
    }
    const ready = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(new BarcodeScanViewError("Waiting for barcode scan UI was cancelled"))
    }
    if (signal?.aborted) return abort()
    if (hosts.size > 0) return ready()
    hostWaiters.add(ready)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export function openBarcodeScanView(options: {
  onCancel: () => void
  onToggleTorch?: () => Promise<void>
}): { close(): void; setTorch(enabled: boolean): void } {
  if (hosts.size === 0) throw new BarcodeScanViewError("Barcode scan UI is not mounted")
  if (activeId !== null) throw new BarcodeScanViewError("Barcode scan UI is already open")
  const id = Symbol("barcode-scan")
  activeId = id
  const close = () => {
    if (activeId !== id) return
    activeId = null
    publish(null)
  }
  const update = (patch: Partial<BarcodeScanSnapshot>) => {
    if (activeId === id && snapshot) publish({ ...snapshot, ...patch })
  }
  publish({
    cancel: () => {
      if (activeId !== id) return
      close()
      options.onCancel()
    },
    toggleTorch: options.onToggleTorch
      ? () => {
          if (activeId !== id || snapshot?.torchPending) return
          update({ torchPending: true, torchError: false })
          void options.onToggleTorch!()
            .catch(() => update({ torchError: true }))
            .finally(() => update({ torchPending: false }))
        }
      : undefined,
    torchEnabled: false,
    torchPending: false,
    torchError: false,
  })
  return { close, setTorch: (enabled) => update({ torchEnabled: enabled, torchError: false }) }
}
