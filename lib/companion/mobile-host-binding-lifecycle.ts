export interface MobileHostBindingController {
  start(): Promise<void>
  stop(): Promise<void>
}

let activeController: MobileHostBindingController | null = null
let pendingRestart: Promise<void> | null = null

/** Register the mounted Mobile provider as the owner of Host-bound services. */
export function registerMobileHostBindingController(
  controller: MobileHostBindingController
): () => void {
  activeController = controller
  return () => {
    if (activeController === controller) activeController = null
  }
}

/**
 * Restart all Host-scoped subscriptions as one awaitable operation.
 * Concurrent config events and target transitions share the same restart.
 */
export function restartMobileHostBindings(): Promise<void> {
  if (pendingRestart) return pendingRestart
  const controller = activeController
  if (!controller) return Promise.resolve()

  const restart = (async () => {
    await controller.stop()
    if (activeController === controller) await controller.start()
  })()
  const trackedRestart = restart.finally(() => {
    if (pendingRestart === trackedRestart) pendingRestart = null
  })
  pendingRestart = trackedRestart
  return trackedRestart
}
