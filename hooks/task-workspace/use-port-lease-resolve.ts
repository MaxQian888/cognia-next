"use client"

import { useEffect, useState } from "react"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { resolveWorkspacePortLease } from "@/lib/task-workspace/client"
import type { WorkspacePortLease } from "@/lib/task-workspace/types"

export interface PortLeaseResolution {
  lease: WorkspacePortLease | null
  loading: boolean
  error: string | null
  /** Web without a desktop or connected host is inert: no read or allocation is attempted. */
  inert: boolean
}

/** Resolve each physical root through the host's read-only command; never ensure a lease. */
export function usePortLeaseResolve(roots: readonly string[]): Record<string, PortLeaseResolution> {
  const rootKey = JSON.stringify([...new Set(roots)])
  const hostAvailable = hasHostRuntime()
  const [snapshot, setSnapshot] = useState<{
    key: string
    results: Record<string, PortLeaseResolution>
  } | null>(null)

  useEffect(() => {
    if (!hostAvailable) return
    let active = true
    const paths: string[] = JSON.parse(rootKey)
    void Promise.all(
      paths.map(async (path): Promise<[string, PortLeaseResolution]> => {
        try {
          const lease = await resolveWorkspacePortLease(path)
          return [path, { lease, loading: false, error: null, inert: false }]
        } catch (error) {
          return [
            path,
            {
              lease: null,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
              inert: false,
            },
          ]
        }
      })
    ).then((entries) => {
      if (active) setSnapshot({ key: rootKey, results: Object.fromEntries(entries) })
    })
    return () => {
      active = false
    }
  }, [hostAvailable, rootKey])

  return Object.fromEntries(
    roots.map((path) => [
      path,
      hostAvailable && snapshot?.key === rootKey
        ? snapshot.results[path]
        : { lease: null, loading: hostAvailable, error: null, inert: !hostAvailable },
    ])
  )
}
