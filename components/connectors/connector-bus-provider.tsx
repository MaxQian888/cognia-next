"use client"

/**
 * ConnectorBusProvider — Task 41 + im-refactored-crayon.
 *
 * Thin React host for the shared connector bootstrap. The whole boot
 * sequence (scheduler executors → WS reap → adapter boot loop → runtime
 * route handler behind the PII gate → outbound runner → sweeps) lives in
 * `lib/connectors/bootstrap/install-connector-runtime.ts` so the headless
 * brain can run the identical code (ADR-0059 T-A5); this component only
 * binds it to the React lifecycle.
 *
 * No-op in web mode (the installer's default host gate is `isTauri()`).
 */

import { useEffect } from "react"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"

export function ConnectorBusProvider({ children }: { children?: React.ReactNode }) {
  useEffect(() => installConnectorRuntime(), [])

  return <>{children}</>
}
