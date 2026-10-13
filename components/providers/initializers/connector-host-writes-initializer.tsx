"use client"

import { useEffect } from "react"

/**
 * Send this shell's connection writes to the Host it drives (ADR-0224), so a
 * phone or a paired browser can set up a bot there. The writer decides per
 * write whether it applies (only where the connector keychain is the Host's),
 * so mounting it everywhere is safe; the modules load lazily.
 */
export function ConnectorHostWritesInitializer() {
  useEffect(() => {
    let cancelled = false
    let restore: (() => void) | undefined

    void (async () => {
      const [{ setAdapterInstanceRemoteWriter }, { createHostAdapterInstanceWriter }] =
        await Promise.all([
          import("@/lib/db/adapter-instance-remote-writer"),
          import("@/lib/connectors/host-instance-writer"),
        ])
      if (cancelled) return
      restore = setAdapterInstanceRemoteWriter(createHostAdapterInstanceWriter())
    })().catch(() => undefined)

    return () => {
      cancelled = true
      restore?.()
    }
  }, [])

  return null
}

export default ConnectorHostWritesInitializer
