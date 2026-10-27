"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  isSandboxStreamUnavailable,
  sandboxClient,
  type SandboxControlLease,
  type SandboxStreamGrant,
} from "@/lib/automation/sandbox-client"

export type SandboxStreamStatus =
  "idle" | "opening" | "connecting" | "unmonitored" | "open" | "unavailable" | "error"

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
  deps: SandboxDesktopStreamDeps = {},
  beforeRecover?: () => Promise<void> | void
) {
  const [status, setStatus] = useState<SandboxStreamStatus>("idle")
  const [grant, setGrant] = useState<SandboxStreamGrant | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameRef.current = frame
  }, [])
  const io = useRef({
    open: deps.open ?? sandboxClient.streamOpen,
    claim: deps.claim ?? sandboxClient.streamClaim,
    close: deps.close ?? sandboxClient.streamClose,
  })
  const releaseBeforeRecovery = useRef(beforeRecover)
  useLayoutEffect(() => {
    releaseBeforeRecovery.current = beforeRecover
  }, [beforeRecover])
  const current = useRef<SandboxStreamGrant | null>(null)
  const generation = useRef(0)
  const live = useRef(false)
  const streamShown = useRef(false)
  const recovering = useRef(false)
  const retries = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRef = useRef<(() => Promise<void>) | null>(null)

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current)
    retryTimer.current = null
  }, [])
  const scheduleRetry = useCallback(() => {
    clearRetry()
    if (!live.current) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retries.current++, 5))
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      void openRef.current?.()
    }, delay)
  }, [clearRetry])
  const closeGrant = useCallback(
    async (previous: SandboxStreamGrant | null) => {
      if (previous) await io.current.close(connectionId, previous.viewerId).catch(() => undefined)
    },
    [connectionId]
  )
  const open = useCallback(async () => {
    if (!live.current) return
    if (recovering.current) {
      scheduleRetry()
      return
    }
    clearRetry()
    const attempt = ++generation.current
    const previous = current.current
    current.current = null
    setGrant(null)
    setStatus("opening")
    streamShown.current = true
    await closeGrant(previous)
    if (attempt !== generation.current || !live.current) return
    try {
      const next = await io.current.open(connectionId)
      if (attempt !== generation.current || !live.current) {
        await closeGrant(next)
        return
      }
      current.current = next
      setGrant(next)
      // The grant authorizes a connection; only child decoder/output liveness
      // can establish that the stream actually started.
      setStatus(next.healthVersion === 1 ? "connecting" : "unmonitored")
    } catch (error) {
      if (attempt !== generation.current || !live.current) return
      streamShown.current = false
      const unavailable = isSandboxStreamUnavailable(error)
      setStatus(unavailable ? "unavailable" : "error")
      if (!unavailable) scheduleRetry()
    }
  }, [clearRetry, closeGrant, connectionId, scheduleRetry])
  useLayoutEffect(() => {
    openRef.current = open
  }, [open])

  const fail = useCallback(async () => {
    const previous = current.current
    if (!live.current || !previous || recovering.current) return
    const attempt = ++generation.current
    recovering.current = true
    clearRetry()
    current.current = null
    streamShown.current = false
    setGrant(null)
    setStatus("error")
    try {
      // Revoke/settle the current human lease before reopening view-only.
      // Recovery never acquires or restores control on the user's behalf.
      await releaseBeforeRecovery.current?.()
    } catch {
      // The stream remains failed. Its grant is still closed below, and any
      // unconfirmed lease can only expire or be settled by the Host.
    } finally {
      await closeGrant(previous)
      recovering.current = false
      if (live.current && generation.current === attempt) scheduleRetry()
    }
  }, [clearRetry, closeGrant, scheduleRetry])

  useEffect(() => {
    live.current = enabled
    if (!enabled) {
      generation.current += 1
      clearRetry()
      const previous = current.current
      current.current = null
      streamShown.current = false
      void closeGrant(previous)
      return
    }
    retries.current = 0
    const start = setTimeout(() => void open(), 0)
    return () => {
      clearTimeout(start)
      clearRetry()
      live.current = false
      generation.current += 1
      const previous = current.current
      current.current = null
      streamShown.current = false
      void closeGrant(previous)
    }
  }, [clearRetry, closeGrant, enabled, open])

  useEffect(() => {
    const frame = frameRef.current
    if (!enabled || !grant || !frame) return
    const target = frame.contentWindow
    if (!target) return
    const frameError = () => void fail()
    frame.addEventListener("error", frameError)
    if (grant.healthVersion !== 1) {
      return () => frame.removeEventListener("error", frameError)
    }
    const origin = new URL(grant.url).origin
    const nonce = crypto.randomUUID()
    let startedAt = Date.now()
    let heartbeatAt = startedAt
    let ready = false
    const observe = () => {
      startedAt = Date.now()
      heartbeatAt = startedAt
      ready = false
      target.postMessage({ type: "cognia-sandbox-stream-observe", version: 1, nonce }, origin)
    }
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data
      if (event.source !== target || event.origin !== origin || !data || typeof data !== "object")
        return
      const health = data as Record<string, unknown>
      if (
        health.type !== "cognia-sandbox-stream-health" ||
        health.version !== 1 ||
        health.nonce !== nonce ||
        typeof health.connected !== "boolean" ||
        typeof health.presented !== "boolean" ||
        (health.failed !== null &&
          (typeof health.failed !== "string" ||
            !["closed", "error", "decoder-failed", "decoder-stalled", "killed"].includes(
              health.failed
            )))
      )
        return
      heartbeatAt = Date.now()
      if (health.failed !== null) {
        void fail()
        return
      }
      ready = health.connected && health.presented
      if (ready) {
        retries.current = 0
        setStatus("open")
      } else setStatus("connecting")
    }
    const visibility = () => {
      if (!document.hidden) observe()
    }
    window.addEventListener("message", receive)
    frame.addEventListener("load", observe)
    document.addEventListener("visibilitychange", visibility)
    observe()
    const timeout = setInterval(() => {
      if (document.hidden) return
      if ((!ready && Date.now() - startedAt >= 15_000) || Date.now() - heartbeatAt >= 15_000)
        void fail()
    }, 1_000)
    return () => {
      clearInterval(timeout)
      window.removeEventListener("message", receive)
      frame.removeEventListener("load", observe)
      frame.removeEventListener("error", frameError)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [enabled, fail, grant])

  const claim = useCallback(
    async (lease: SandboxControlLease): Promise<boolean> => {
      if (!live.current || recovering.current) return false
      const viewer = current.current
      if (!viewer) {
        if (streamShown.current) return false
        // Explicit screenshot-mode control pauses automatic stream recovery.
        // Releasing the lease will reopen a viewer grant through `reopen`.
        clearRetry()
        return true
      }
      const attempt = generation.current
      try {
        const next = await io.current.claim(connectionId, viewer.viewerId, lease.token, lease.fence)
        if (attempt !== generation.current || !live.current) return false
        current.current = next
        setGrant(next)
        setStatus(next.healthVersion === 1 ? "connecting" : "unmonitored")
        return true
      } catch {
        return false
      }
    },
    [clearRetry, connectionId]
  )
  const reopen = useCallback(async () => {
    if (!live.current || recovering.current) return
    await open()
  }, [open])

  return {
    status: enabled ? status : "idle",
    grant: enabled ? grant : null,
    attachFrame,
    claim,
    reopen,
    fail,
  }
}
