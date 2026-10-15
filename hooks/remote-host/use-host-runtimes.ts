"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  HostRuntimesUnavailableError,
  readHostRuntimes,
  restartHostRuntime,
  type HostRuntime,
  type HostRuntimes,
  type HostRuntimesUnavailableReason,
} from "@/lib/remote-host/host-runtimes"

/** How often a host with a runtime mid-restart is read again. */
export const HOST_RUNTIMES_POLL_MS = 3_000

export interface UseHostRuntimesDeps {
  read?: (hostRef: string) => Promise<HostRuntimes>
  restart?: (hostRef: string, name: string) => Promise<HostRuntimes>
  pollMs?: number
}

export interface UseHostRuntimesResult {
  /** Null until the first read lands. */
  runtimes: HostRuntime[] | null
  /** Why this host cannot report runtimes at all. */
  unavailable: HostRuntimesUnavailableReason | null
  /** Why the last read failed, if it did. */
  error: string | null
  loading: boolean
  /** The runtime this device is restarting. */
  restarting: string | null
  reload: () => Promise<void>
  /**
   * Restart one runtime. Resolves to the runtime as it is afterwards, or an
   * error message when the host refused or could not be reached.
   */
  restart: (name: string) => Promise<{ runtime?: HostRuntime; error?: string }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * An always-on host's headless runtimes (ADR-0059 W2). Read on mount, on
 * focus and when asked, and every few seconds while one is restarting.
 */
export function useHostRuntimes(
  hostRef: string | null,
  deps: UseHostRuntimesDeps = {}
): UseHostRuntimesResult {
  const read = deps.read ?? readHostRuntimes
  const restartDep = deps.restart ?? restartHostRuntime
  const pollMs = deps.pollMs ?? HOST_RUNTIMES_POLL_MS
  const [runtimes, setRuntimes] = useState<HostRuntime[] | null>(null)
  const [unavailable, setUnavailable] = useState<HostRuntimesUnavailableReason | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [restarting, setRestarting] = useState<string | null>(null)
  // Only the newest read may land: a slow read for the previous host, or one
  // that started before a restart answered, must not overwrite it.
  const generation = useRef(0)

  const land = useCallback((next: HostRuntimes) => {
    setRuntimes(next.runtimes)
    setUnavailable(null)
    setError(null)
  }, [])

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof HostRuntimesUnavailableError) setUnavailable(cause.reason)
    else setError(messageOf(cause))
  }, [])

  const reload = useCallback(async () => {
    const ticket = ++generation.current
    if (!hostRef) {
      setRuntimes(null)
      setUnavailable(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await read(hostRef)
      if (ticket === generation.current) land(next)
    } catch (cause) {
      if (ticket === generation.current) fail(cause)
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [hostRef, read, land, fail])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read on mount; its results land after the await
    void reload()
    const onFocus = () => void reload()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [reload])

  const moving = runtimes?.some((runtime) => runtime.state === "restarting") ?? false
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => void reload(), pollMs)
    return () => clearInterval(timer)
  }, [moving, pollMs, reload])

  const restart = useCallback(
    async (name: string) => {
      if (!hostRef) return { error: "no host" }
      setRestarting(name)
      try {
        const next = await restartDep(hostRef, name)
        generation.current += 1
        land(next)
        setLoading(false)
        return { runtime: next.runtime }
      } catch (cause) {
        if (cause instanceof HostRuntimesUnavailableError) setUnavailable(cause.reason)
        return { error: messageOf(cause) }
      } finally {
        setRestarting(null)
      }
    },
    [hostRef, restartDep, land]
  )

  return { runtimes, unavailable, error, loading, restarting, reload, restart }
}
