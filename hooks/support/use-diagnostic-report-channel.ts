"use client"

/**
 * Registers "send to the diagnostic service" as a support-report channel while
 * the report dialog is mounted.
 *
 * Registration is scoped to the dialog rather than done once at boot for two
 * reasons: the channel registry is a module singleton whose entries have to be
 * removed as cleanly as they are added, and the channel is only meaningful
 * while a service is configured — which can change while the app is running.
 *
 * The registry notifies its own subscribers, so nothing has to be returned:
 * a surface that reads it through `useSyncExternalStore` re-renders on its own
 * once the registration lands.
 */

import { useEffect } from "react"

import { useDiagnosticConnection } from "@/hooks/diagnostic-service/use-diagnostic-connection"
import { createDiagnosticReportChannel } from "@/lib/support-report/diagnostic-channel"
import { registerSupportReportChannel } from "@/lib/support-report/channels"

export function useDiagnosticReportChannel(): void {
  const service = useDiagnosticConnection()

  useEffect(() => {
    if (!service.client) return
    let unregister: (() => void) | undefined
    try {
      unregister = registerSupportReportChannel(
        createDiagnosticReportChannel({ client: service.client })
      )
    } catch {
      // Duplicate id: another mount of the dialog got there first. Its
      // registration is equivalent, so leaving it alone is correct — and
      // throwing here would take the whole report dialog down.
      return
    }
    return () => {
      unregister?.()
    }
  }, [service.client])
}
