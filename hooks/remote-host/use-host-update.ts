"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  HostUpdateUnsupportedError,
  configureHostUpdate,
  installHostUpdate,
  isHostUpdateInFlight,
  readHostUpdateStatus,
  refreshHostUpdate,
  type HostUpdateChannel,
  type HostUpdateStatus,
} from "@/lib/remote-host/host-update"

/** How often a host that is moving is read again. */
export const HOST_UPDATE_POLL_MS = 5_000

export type HostUpdateAction = "refresh" | "install" | "configure"

export interface UseHostUpdateDeps {
  read?: (hostId: string) => Promise<HostUpdateStatus>
  refresh?: (hostId: string) => Promise<HostUpdateStatus>
  install?: (hostId: string) => Promise<HostUpdateStatus>
  configure?: (
    hostId: string,
    patch: { channel?: HostUpdateChannel; autoUpdate?: boolean }
  ) => Promise<HostUpdateStatus>
  pollMs?: number
}

export interface UseHostUpdateResult {
  /** Null until the first read lands. */
  status: HostUpdateStatus | null
  /** The host predates self-update. */
  unsupported: boolean
  /** Why the last read failed, if it did. */
  error: string | null
  /** The action under way, so its control can show it. */
  pending: HostUpdateAction | null
  reload: () => Promise<void>
  /** Each resolves to an error message, or null when the host took it. */
  refresh: () => Promise<string | null>
  install: () => Promise<string | null>
  configure: (patch: {
    channel?: HostUpdateChannel
    autoUpdate?: boolean
  }) => Promise<string | null>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A host's own update state (ADR-0224 A10). Read on mount and on focus, and
 * every few seconds while the host is checking, waiting, swapping or proving
 * a new version, including while it is down restarting.
 */
export function useHostUpdate(
  hostId: string | null,
  deps: UseHostUpdateDeps = {}
): UseHostUpdateResult {
  const read = deps.read ?? readHostUpdateStatus
  const pollMs = deps.pollMs ?? HOST_UPDATE_POLL_MS
  const [status, setStatus] = useState<HostUpdateStatus | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<HostUpdateAction | null>(null)
  // Only the newest read may land.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostId) {
      setStatus(null)
      return
    }
    try {
      const next = await read(hostId)
      if (ticket !== generation.current) return
      setStatus(next)
      setUnsupported(false)
      setError(null)
    } catch (cause) {
      if (ticket !== generation.current) return
      if (cause instanceof HostUpdateUnsupportedError) setUnsupported(true)
      else setError(messageOf(cause))
    }
  }, [hostId, read])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
    const onFocus = () => void reload()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [reload])

  const moving = status !== null && isHostUpdateInFlight(status)
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => void reload(), pollMs)
    return () => clearInterval(timer)
  }, [moving, pollMs, reload])

  const act = useCallback(
    async (action: HostUpdateAction, run: (hostId: string) => Promise<HostUpdateStatus>) => {
      if (!hostId) return null
      setPending(action)
      try {
        const next = await run(hostId)
        generation.current += 1
        setStatus(next)
        setError(null)
        return null
      } catch (cause) {
        if (cause instanceof HostUpdateUnsupportedError) setUnsupported(true)
        return messageOf(cause)
      } finally {
        setPending(null)
      }
    },
    [hostId]
  )

  const refresh = useCallback(
    () => act("refresh", deps.refresh ?? refreshHostUpdate),
    [act, deps.refresh]
  )
  const install = useCallback(
    () => act("install", deps.install ?? installHostUpdate),
    [act, deps.install]
  )
  const configureDep = deps.configure
  const configure = useCallback(
    (patch: { channel?: HostUpdateChannel; autoUpdate?: boolean }) =>
      act("configure", (id) => (configureDep ?? configureHostUpdate)(id, patch)),
    [act, configureDep]
  )

  return { status, unsupported, error, pending, reload, refresh, install, configure }
}
