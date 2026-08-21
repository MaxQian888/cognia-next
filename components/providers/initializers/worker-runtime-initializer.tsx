"use client"

/**
 * WorkerRuntimeInitializer — makes this desktop host able to dispatch to the
 * execution workers it already accepts.
 *
 * ADR-0113's cross-host dispatch is complete on both ends, but the only caller
 * of `installRemoteWorkerRuntime` was the headless `cognia serve` process. On
 * desktop the runtime slot stayed empty, so an enrolled worker authenticated,
 * appeared online in Fleet, and never received a frame — the failure was
 * invisible because every send was discarded by the host. Mounting this makes
 * the WebView the brain for that host.
 *
 * Attaching is idempotent per mount and torn down on unmount: the host replaces
 * any previously attached channel, so a WebView reload re-announces the live
 * roster rather than stranding it.
 */

import { useEffect, useRef } from "react"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  attachTauriWorkerRuntime,
  type TauriWorkerRuntimeHandle,
} from "@/lib/ai/agent/team/tauri-worker-runtime"
import { useAccountStore } from "@/stores/account/account-store"

export function WorkerRuntimeInitializer() {
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const lifecycle = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let handle: TauriWorkerRuntimeHandle | undefined
    let disposed = false
    const tenantId = getActiveAccountId()

    lifecycle.current = lifecycle.current.then(async () => {
      if (disposed) return
      try {
        const attached = await attachTauriWorkerRuntime({ tenantId })
        if (disposed) {
          await attached.dispose()
          return
        }
        handle = attached
      } catch (error) {
        // A host whose companion server never started has no worker ingress to
        // attach to. That is an ordinary configuration, not a fault, so it is
        // reported at debug level — the Fleet card is what tells the user that
        // dispatch is unavailable.
        if (!disposed) console.debug("worker runtime attach skipped", error)
      }
    })

    return () => {
      disposed = true
      lifecycle.current = lifecycle.current.then(async () => {
        try {
          await handle?.dispose()
        } catch (error) {
          console.debug("worker runtime dispose skipped", error)
        }
        handle = undefined
      })
    }
  }, [accountRevision])

  return null
}

export default WorkerRuntimeInitializer
