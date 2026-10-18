"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  isSandboxStreamUnavailable,
  sandboxClient,
  type SandboxControlLease,
  type SandboxStreamGrant,
} from "@/lib/automation/sandbox-client"

export type SandboxStreamStatus = "idle" | "opening" | "open" | "unavailable" | "error"

export interface SandboxDesktopStreamDeps {
  open?: (connectionId: string) => Promise<SandboxStreamGrant>
  claim?: (
    connectionId: string,
    viewerId: string,
    token: string,
    fence: number
  ) => Promise<SandboxStreamGrant>
  close?: (connectionId: string, viewerId: string) => Promise<void>
}

/**
 * One viewer grant on a sandbox's Selkies stream (ADR-0234 Phase 4).
 *
 * It opens a view-only grant while enabled and closes it when disabled or
 * unmounted. After the desktop hook acquires the control lease, `claim` swaps
 * the grant for a controller one. After the lease is released or lost,
 * `reopen` replaces it with a fresh viewer grant; by then the Host has
 * already revoked the controller and confirmed its session closed. A sandbox
 * whose image has no Selkies reports `unavailable`, and the viewer keeps
 * polling screenshots.
 */
export function useSandboxDesktopStream(
  connectionId: string,
  enabled: boolean,
  deps: SandboxDesktopStreamDeps = {}
) {
  const [status, setStatus] = useState<SandboxStreamStatus>("idle")
  const [grant, setGrant] = useState<SandboxStreamGrant | null>(null)
  const io = useRef({
    open: deps.open ?? sandboxClient.streamOpen,
    claim: deps.claim ?? sandboxClient.streamClaim,
    close: deps.close ?? sandboxClient.streamClose,
  })
  const current = useRef<SandboxStreamGrant | null>(null)
  const generation = useRef(0)
  const live = useRef(false)
  // Whether a stream is (being) shown. Without one the viewer polls
  // screenshots, and the control lease is carried by those.
  const streamShown = useRef(false)

  const drop = useCallback(() => {
    const previous = current.current
    current.current = null
    if (previous) void io.current.close(connectionId, previous.viewerId).catch(() => undefined)
  }, [connectionId])

  const open = useCallback(async () => {
    const attempt = ++generation.current
    drop()
    setGrant(null)
    setStatus("opening")
    streamShown.current = true
    try {
      const next = await io.current.open(connectionId)
      if (attempt !== generation.current || !live.current) {
        void io.current.close(connectionId, next.viewerId).catch(() => undefined)
        return
      }
      current.current = next
      setGrant(next)
      setStatus("open")
    } catch (error) {
      if (attempt !== generation.current) return
      streamShown.current = false
      setStatus(isSandboxStreamUnavailable(error) ? "unavailable" : "error")
    }
  }, [connectionId, drop])

  useEffect(() => {
    live.current = enabled
    if (!enabled) {
      // What a disabled stream shows is derived below; only the grant goes.
      generation.current += 1
      drop()
      return
    }
    const start = setTimeout(() => void open(), 0)
    return () => {
      clearTimeout(start)
      live.current = false
      generation.current += 1
      drop()
    }
  }, [drop, enabled, open])

  /**
   * Upgrade this viewer to controller. `true` also when there is no stream
   * (no Selkies, or it failed): the polling viewer carries the lease then.
   * `false` when a stream is shown or opening and cannot take control.
   */
  const claim = useCallback(
    async (lease: SandboxControlLease): Promise<boolean> => {
      if (!live.current) return false
      const viewer = current.current
      if (!viewer) return !streamShown.current
      const attempt = generation.current
      try {
        const next = await io.current.claim(connectionId, viewer.viewerId, lease.token, lease.fence)
        if (attempt !== generation.current || !live.current) return false
        current.current = next
        setGrant(next)
        return true
      } catch {
        return false
      }
    },
    [connectionId]
  )

  const reopen = useCallback(async () => {
    if (!live.current) return
    await open()
  }, [open])

  return { status: enabled ? status : "idle", grant: enabled ? grant : null, claim, reopen }
}
