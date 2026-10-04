"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { sandboxClient, type SandboxControlLease } from "@/lib/automation/sandbox-client"
import type { Point, Screenshot, UiAction } from "@/lib/automation/types"

export type SandboxDesktopError = "capture" | "control" | "input" | "release" | null
const POLL_MS = 1_000
const MAX_FRAME_AGE_MS = 5_000

/** The session closure owns all timers and leases, including late async completions. */
export function useSandboxDesktop(connectionId: string, enabled: boolean) {
  const [frame, setFrame] = useState<Screenshot | null>(null)
  const [controlling, setControlling] = useState(false)
  const [acquiring, setAcquiring] = useState(false)
  const [error, setError] = useState<SandboxDesktopError>(null)
  const session = useRef<{
    acquire: () => Promise<void>
    release: () => Promise<void>
    refresh: () => Promise<void>
    input: (action: UiAction, point: Point | null, capturedAt: number) => Promise<boolean>
  } | null>(null)

  useEffect(() => {
    let alive = true
    let lease: SandboxControlLease | null = null
    let acquiringLease = false
    let generation = 0
    let capturing = false
    let currentFrame: Screenshot | null = null
    let receivedAt = 0
    let poll: ReturnType<typeof setTimeout> | undefined
    let renewal: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let inputs: Promise<unknown> = Promise.resolve()
    // This transport talks to the client-local Tauri host. Losing an external
    // network connection does not make a local Docker desktop unavailable.
    const visible = () => enabled && !document.hidden

    const release = async () => {
      generation += 1
      const previous = lease
      lease = null
      clearTimeout(renewal)
      clearTimeout(expiry)
      if (alive) {
        setControlling(false)
        setAcquiring(false)
      }
      if (previous) {
        try {
          await sandboxClient.releaseControl(connectionId, previous.token)
        } catch {
          // The backend lease also expires, so a disconnected viewer cannot
          // retain control indefinitely. Never reuse a locally released token.
          if (alive) setError("release")
        }
      }
    }

    const scheduleRenewal = () => {
      if (!lease) return
      const token = lease.token
      clearTimeout(expiry)
      expiry = setTimeout(() => void release(), Math.max(0, lease.expiresAt - Date.now()))
      renewal = setTimeout(async () => {
        try {
          const next = await sandboxClient.renewControl(connectionId, token)
          if (!alive || lease?.token !== token || !visible()) return
          lease = next
          scheduleRenewal()
        } catch {
          if (!alive || lease?.token !== token) return
          await release()
          if (alive) setError("control")
        }
      }, 5_000)
    }

    const refresh = async () => {
      if (!alive || !visible() || capturing) return
      clearTimeout(poll)
      capturing = true
      try {
        const next = await sandboxClient.desktopFrame(connectionId)
        if (!alive || !visible()) return
        if (!next.bytes || next.width <= 0 || next.height <= 0) throw new Error("Invalid frame")
        currentFrame = next
        receivedAt = Date.now()
        setFrame(next)
        setError((previous) => (previous === "capture" ? null : previous))
      } catch {
        if (!alive) return
        currentFrame = null
        setFrame(null)
        await release()
        if (alive) setError("capture")
      } finally {
        capturing = false
        if (alive && visible()) poll = setTimeout(() => void refresh(), POLL_MS)
      }
    }

    const acquire = async () => {
      if (!alive || !visible() || lease || acquiringLease || !currentFrame) return
      const requestedGeneration = generation
      acquiringLease = true
      setAcquiring(true)
      setError(null)
      try {
        const next = await sandboxClient.acquireControl(connectionId)
        if (!alive || !visible() || generation !== requestedGeneration) {
          await sandboxClient.releaseControl(connectionId, next.token)
          return
        }
        lease = next
        setControlling(true)
        scheduleRenewal()
      } catch {
        if (alive) setError("control")
      } finally {
        acquiringLease = false
        if (alive) setAcquiring(false)
      }
    }

    const input = (action: UiAction, point: Point | null, capturedAt: number): Promise<boolean> => {
      const token = lease?.token
      const requestedGeneration = generation
      const observedFrame = currentFrame
      // Validate the pixels the user acted on when accepting the event. A
      // newer capture must not discard already accepted keyboard input.
      if (
        !observedFrame ||
        observedFrame.capturedAt !== capturedAt ||
        Date.now() - receivedAt > MAX_FRAME_AGE_MS
      )
        return Promise.resolve(false)
      const result = inputs.then(async () => {
        if (
          !alive ||
          !visible() ||
          !token ||
          lease?.token !== token ||
          generation !== requestedGeneration ||
          Date.now() >= lease.expiresAt ||
          !currentFrame ||
          (point !== null &&
            (currentFrame.width !== observedFrame.width ||
              currentFrame.height !== observedFrame.height ||
              currentFrame.sourceWidth !== observedFrame.sourceWidth ||
              currentFrame.sourceHeight !== observedFrame.sourceHeight)) ||
          Date.now() - receivedAt > MAX_FRAME_AGE_MS
        )
          return false
        try {
          await sandboxClient.controlInput(connectionId, token, point, action)
          return true
        } catch {
          await release()
          if (alive) setError("input")
          return false
        }
      })
      inputs = result
      return result
    }

    const visibilityChanged = () => {
      if (!visible()) {
        clearTimeout(poll)
        currentFrame = null
        setFrame(null)
        void release()
      } else void refresh()
    }
    const blur = () => void release()
    session.current = { acquire, release, refresh, input }
    const initial = setTimeout(() => {
      setFrame(null)
      setControlling(false)
      setError(null)
      void refresh()
    }, 0)
    document.addEventListener("visibilitychange", visibilityChanged)
    window.addEventListener("blur", blur)
    return () => {
      alive = false
      session.current = null
      clearTimeout(initial)
      clearTimeout(poll)
      void release()
      document.removeEventListener("visibilitychange", visibilityChanged)
      window.removeEventListener("blur", blur)
    }
  }, [connectionId, enabled])

  const acquire = useCallback(() => session.current?.acquire(), [])
  const release = useCallback(() => session.current?.release(), [])
  const refresh = useCallback(() => session.current?.refresh(), [])
  const input = useCallback(
    (action: UiAction, point: Point | null, capturedAt: number) =>
      session.current?.input(action, point, capturedAt) ?? Promise.resolve(false),
    []
  )
  return {
    frame: enabled ? frame : null,
    controlling: enabled && controlling,
    acquiring,
    error,
    acquire,
    release,
    refresh,
    input,
  }
}
