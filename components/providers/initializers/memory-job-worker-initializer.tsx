"use client"

import { useEffect } from "react"
import { startMemoryJobWorker } from "@/lib/memory/lifecycle/job-worker"

/** Recover queued learned-memory work after renderer restarts. */
export function MemoryJobWorkerInitializer() {
  useEffect(() => startMemoryJobWorker(), [])
  return null
}

export default MemoryJobWorkerInitializer
