"use client"

/**
 * Durable inbound jobs for one conversation that stalled mid-flight and need
 * an operator decision (continue safely / retry from the start / dismiss).
 *
 * Extracted from `inbound-recovery-panel.tsx`. Unlike its siblings that file
 * had **no** SSR guard on the live query — `getDb()` off the DOM throws — so
 * one is added here.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { ConnectorInboundJobRow } from "@/lib/db/connector-types"

export function useInboundRecoveryJobs(
  conversationKey: string | undefined
): ConnectorInboundJobRow[] {
  return (
    useLiveQuery<ConnectorInboundJobRow[]>(() => {
      if (typeof window === "undefined" || !conversationKey) return Promise.resolve([])
      return getDb()
        .connectorInboundJobs.where("conversationKey")
        .equals(conversationKey)
        .filter((job) => job.status === "recovery_required")
        .toArray()
    }, [conversationKey]) ?? []
  )
}
