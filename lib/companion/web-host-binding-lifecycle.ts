let pendingRestart:
  | {
      promise: Promise<void>
      resolve: () => void
      reject: (error: unknown) => void
    }
  | undefined
let ownerRegistered = false

export function registerWebHostBindingOwner(): () => void {
  ownerRegistered = true
  return () => {
    ownerRegistered = false
  }
}

/** Request the mounted Web provider to rebuild Host-scoped subscriptions. */
export function restartWebHostBindings(): Promise<void> {
  if (pendingRestart) return pendingRestart.promise
  if (!ownerRegistered) {
    return Promise.reject(new Error("The Web Host binding provider is not mounted."))
  }
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  pendingRestart = { promise, resolve, reject }
  window.dispatchEvent(new Event("cognia:companion-config-changed"))
  return promise
}

/** Complete the transition only after the new Web Host listeners are bound. */
export function notifyWebHostBindingsReady(): void {
  const pending = pendingRestart
  pendingRestart = undefined
  pending?.resolve()
}

/** Fail activation when the Web provider cannot bind the selected Host. */
export function notifyWebHostBindingsFailed(error: unknown): void {
  const pending = pendingRestart
  pendingRestart = undefined
  pending?.reject(error)
}
