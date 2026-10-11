"use client"

import { useCallback } from "react"

import {
  acquireManagementChannel,
  type ManagementChannelLease,
} from "@/lib/remote-host/management-channel"

export interface UseManagementChannelDeps {
  acquire?: (hostRef: string) => Promise<ManagementChannelLease>
}

export interface UseManagementChannelResult {
  /**
   * Call one command on the host over its management channel. Rejects when
   * there is no host, the channel cannot open, or the host refuses.
   */
  call: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>
}

/**
 * The management channel to one remote host, for host panels (ADR-0224 A4).
 *
 * Every call takes a lease and gives it back, so a panel never holds a
 * connection open by being mounted; the channel itself stays warm for a while
 * after the last call (`MANAGEMENT_CHANNEL_IDLE_MS`) and is shared with the
 * liveness probe and every other panel looking at the same host. The app's
 * routing is never touched: managing the always-on host does not make this
 * desktop its client.
 *
 * @param hostRef the `RemoteHost.id` or the host's stable identity; `null`
 *   when no remote host is selected.
 */
export function useManagementChannel(
  hostRef: string | null,
  deps: UseManagementChannelDeps = {}
): UseManagementChannelResult {
  const acquire = deps.acquire ?? acquireManagementChannel
  const call = useCallback(
    async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (!hostRef) throw new Error("no remote host is selected")
      const lease = await acquire(hostRef)
      try {
        return await lease.transport.call<T>(name, args)
      } finally {
        lease.release()
      }
    },
    [hostRef, acquire]
  )
  return { call }
}
