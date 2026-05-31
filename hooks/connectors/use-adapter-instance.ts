"use client"

/**
 * Live-query a single `AdapterInstanceRow` by id.
 *
 * `useAdapterHealth` covers heartbeat/breaker state; this hook exposes the
 * adapter's *configuration* row (quiet hours, @-response strategy, mute, etc.)
 * so the conversation header can surface policy chips without each chip opening
 * its own subscriber.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export function useAdapterInstance(
  adapterId: string | null | undefined
): AdapterInstanceRow | undefined {
  return useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined" || !adapterId
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
}
