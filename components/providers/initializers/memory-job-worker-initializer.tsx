"use client"

import { useEffect, useRef } from "react"
import { startMemoryJobWorker } from "@/lib/memory/lifecycle/job-worker"

/** Recover queued learned-memory work after renderer restarts. */
export function MemoryJobWorkerInitializer() {
  // One identity per window, not per build. Completion is fenced by
  // `leaseOwner` now, so two windows sharing the default id would each accept
  // the other's completions and quietly overwrite the running row. Mirrors
  // `lib/connectors/bus.ts`, which owns its leases the same way.
  const workerId = useRef<string>(undefined)
  workerId.current ??= `renderer-memory-job-worker:${crypto.randomUUID()}`
  useEffect(() => startMemoryJobWorker({ workerId: workerId.current }), [])
  return null
}

export default MemoryJobWorkerInitializer
