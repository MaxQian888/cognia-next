"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  sandboxClient,
  type SandboxControlLease,
  type SandboxDesktopFrame,
  type SandboxDesktopSession,
  type SandboxDesktopStatus,
  type OpenSandboxDesktop,
} from "@/lib/automation/sandbox-client"
import type { Point, Screenshot, UiAction } from "@/lib/automation/types"

export type SandboxDesktopError = "capture" | "control" | "input" | "release" | "session" | null
const POLL_MS = 1_000
/** While a Selkies stream shows the desktop, snapshots only gate control. */
export const STREAM_POLL_MS = 5_000
const MAX_FRAME_AGE_MS = 5_000

export interface SandboxDesktopOptions {
  /** A Selkies stream is on screen (ADR-0234 Phase 4); poll snapshots slowly. */
  streaming?: boolean
  /**
   * The lease after acquisition, and `null` once it is released or lost. The
   * `null` comes after the Host answered the release, which revokes any stream
   * controller first.
   */
  onLeaseChange?: (lease: SandboxControlLease | null) => void
}

/** The stream frame of this connection holds focus inside this window. */
function focusInStream(connectionId: string): boolean {
  const active = document.activeElement
  return (
    document.hasFocus() &&
    active instanceof HTMLIFrameElement &&
    active.dataset.sandboxStream === connectionId
  )
}

/** The session closure owns all timers and leases, including late async completions. */
export function useSandboxDesktop(
  connectionId: string,
  enabled: boolean,
  openDesktop?: OpenSandboxDesktop,
  inputAllowed = true,
  options: SandboxDesktopOptions = {}
) {
  const [status, setStatus] = useState<SandboxDesktopStatus | null>(null)
  const [frame, setFrame] = useState<Screenshot | null>(null)
  const [controlling, setControlling] = useState(false)
  const [acquiring, setAcquiring] = useState(false)
  const [error, setError] = useState<SandboxDesktopError>(null)
  // Read through refs: toggling the stream must not restart the session and
  // drop the lease.
  const streaming = useRef(Boolean(options.streaming))
  const leaseChange = useRef(options.onLeaseChange)
  useLayoutEffect(() => {
    streaming.current = Boolean(options.streaming)
    leaseChange.current = options.onLeaseChange
  })
  const session = useRef<{
    acquire: (takeover?: boolean) => Promise<void>
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
    let captureEpoch = 0
    let mutationPending = false
    let refreshPending = false
    let consumedFrameId: string | undefined
    let currentFrame: Screenshot | null = null
    let currentProof: SandboxDesktopFrame | null = null
    let controlStatus: SandboxDesktopStatus | null = null
    let invalidated = false
    let detachInvalidated: (() => void) | undefined
    let desktop: SandboxDesktopSession | null = openDesktop
      ? null
      : {
          managed: false,
          frame: () => sandboxClient.desktopFrame(connectionId),
          acquire: () => sandboxClient.acquireControl(connectionId, true),
          renew: (current) =>
            sandboxClient.renewControl(connectionId, current.token, current.fence),
          release: (current) =>
            sandboxClient.releaseControl(connectionId, current.token, current.fence),
          input: (current, proof, point, action) =>
            sandboxClient.controlInput(
              connectionId,
              current.token,
              current.fence,
              proof.frameId,
              point,
              action
            ),
          close: () => undefined,
        }
    let receivedAt = 0
    let poll: ReturnType<typeof setTimeout> | undefined
    let renewal: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let inputs: Promise<unknown> = Promise.resolve()
    // This transport talks to the client-local Tauri host. Losing an external
    // network connection does not make a local Docker desktop unavailable.
    const visible = () =>
      enabled && !invalidated && !document.hidden && (!openDesktop || navigator.onLine)

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
          await desktop?.release(previous)
        } catch {
          // The backend lease also expires, so a disconnected viewer cannot
          // retain control indefinitely. Never reuse a locally released token.
          if (alive) setError("release")
        }
        leaseChange.current?.(null)
      }
    }

    const scheduleRenewal = () => {
      if (!lease) return
      const token = lease.token
      clearTimeout(expiry)
      expiry = setTimeout(() => void release(), Math.max(0, lease.expiresAt - Date.now()))
      renewal = setTimeout(async () => {
        try {
          const next = await desktop!.renew(lease!)
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
      if (!alive || !visible() || !desktop) return
      if (capturing || mutationPending) {
        refreshPending = true
        return
      }
      refreshPending = false
      const requestedCaptureEpoch = captureEpoch
      clearTimeout(poll)
      capturing = true
      try {
        const requestedGeneration = generation
        if (desktop.status) {
          controlStatus = await desktop.status()
          if (
            !alive ||
            !visible() ||
            generation !== requestedGeneration ||
            captureEpoch !== requestedCaptureEpoch
          )
            return
          setStatus(controlStatus)
          if (
            !controlStatus.qualified ||
            ["dormant", "quarantined", "unavailable"].includes(controlStatus.state)
          ) {
            currentFrame = null
            currentProof = null
            setFrame(null)
            if (lease) await release()
            return
          }
          if (lease && (!controlStatus.controllerIsSelf || controlStatus.fence !== lease.fence)) {
            await release()
            return
          }
        }
        const proof = await desktop.frame()
        const next = proof.screenshot
        if (
          !alive ||
          !visible() ||
          generation !== requestedGeneration ||
          captureEpoch !== requestedCaptureEpoch
        )
          return
        if (
          !proof.frameId ||
          !Number.isFinite(proof.expiresAt) ||
          proof.expiresAt <= Date.now() ||
          (lease && proof.fence !== lease.fence)
        )
          throw new Error("Invalid frame proof")
        currentProof = proof
        if (!next.bytes || next.width <= 0 || next.height <= 0) throw new Error("Invalid frame")
        currentFrame = next
        receivedAt = Date.now()
        setFrame(next)
        setError((previous) => (previous === "capture" ? null : previous))
      } catch {
        if (!alive || captureEpoch !== requestedCaptureEpoch) return
        currentFrame = null
        setFrame(null)
        await release()
        if (alive) setError("capture")
      } finally {
        capturing = false
        if (alive && visible())
          poll = setTimeout(
            () => void refresh(),
            refreshPending ? 0 : streaming.current ? STREAM_POLL_MS : POLL_MS
          )
      }
    }

    const acquire = async (takeover = false) => {
      if (
        !alive ||
        !visible() ||
        !inputAllowed ||
        !desktop ||
        lease ||
        acquiringLease ||
        !currentFrame ||
        (desktop.managed && !controlStatus?.canAcquire)
      )
        return
      const requestedGeneration = generation
      acquiringLease = true
      setAcquiring(true)
      setError(null)
      try {
        const next = await desktop.acquire(takeover)
        if (!alive || !visible() || generation !== requestedGeneration) {
          await desktop.release(next)
          return
        }
        lease = next
        scheduleRenewal()
        // Fence invalidates every observer frame. A capture begun before
        // acquisition must never overwrite the fresh controller frame.
        generation += 1
        currentFrame = null
        currentProof = null
        setFrame(null)
        const acquiredGeneration = generation
        const proof = await desktop.frame()
        if (
          !alive ||
          !visible() ||
          generation !== acquiredGeneration ||
          lease?.token !== next.token
        )
          return
        if (
          !proof.frameId ||
          !Number.isFinite(proof.expiresAt) ||
          proof.fence !== next.fence ||
          proof.expiresAt! <= Date.now() ||
          !proof.screenshot.bytes ||
          proof.screenshot.width <= 0 ||
          proof.screenshot.height <= 0
        )
          throw new Error("Invalid controller frame")
        currentProof = proof
        currentFrame = proof.screenshot
        receivedAt = Date.now()
        setFrame(proof.screenshot)
        setControlling(true)
        leaseChange.current?.(next)
      } catch {
        await release()
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
      const observedProof = currentProof
      const inputLease = lease
      // Validate the pixels the user acted on when accepting the event. A
      // newer capture must not discard already accepted keyboard input.
      if (
        !inputAllowed ||
        !observedProof ||
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
          if (
            !inputLease ||
            !observedProof ||
            !desktop ||
            observedProof.expiresAt <= Date.now() ||
            observedProof.fence !== inputLease.fence
          )
            return false
          // The Host consumes every frame proof after one mutation. A queued
          // event must not reuse that proof or adopt newer coordinates.
          if (currentProof !== observedProof || observedProof.frameId === consumedFrameId)
            return false
          consumedFrameId = observedProof.frameId
          currentProof = null
          captureEpoch += 1
          mutationPending = true
          try {
            await desktop.input(inputLease, observedProof, point, action)
          } finally {
            mutationPending = false
          }
          await refresh()
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
    // Focus moving into this desktop's stream frame blurs the window too; that
    // is the user starting to work, not leaving.
    const blur = () =>
      setTimeout(() => {
        if (!focusInStream(connectionId)) void release()
      }, 0)
    const invalidate = () => {
      invalidated = true
      clearTimeout(poll)
      currentFrame = null
      currentProof = null
      if (alive) {
        setFrame(null)
        setStatus(null)
        setError("session")
      }
      void release()
    }
    const networkChanged = () => {
      if (openDesktop) visibilityChanged()
    }
    session.current = { acquire, release, refresh, input }
    const initial = setTimeout(() => {
      setFrame(null)
      setControlling(false)
      setError(null)
      setStatus(null)
      if (openDesktop && enabled) {
        void openDesktop()
          .then((opened) => {
            if (!alive) {
              opened.close()
              return
            }
            desktop = opened
            detachInvalidated = opened.onInvalidated?.(invalidate)
            void refresh()
          })
          .catch(() => {
            if (alive) {
              invalidate()
              setError("capture")
            }
          })
      } else void refresh()
    }, 0)
    document.addEventListener("visibilitychange", visibilityChanged)
    window.addEventListener("blur", blur)
    window.addEventListener("offline", networkChanged)
    window.addEventListener("online", networkChanged)
    return () => {
      alive = false
      session.current = null
      clearTimeout(initial)
      clearTimeout(poll)
      void release().finally(() => desktop?.close())
      detachInvalidated?.()
      document.removeEventListener("visibilitychange", visibilityChanged)
      window.removeEventListener("blur", blur)
      window.removeEventListener("offline", networkChanged)
      window.removeEventListener("online", networkChanged)
    }
  }, [connectionId, enabled, openDesktop, inputAllowed])

  const acquire = useCallback((takeover = false) => session.current?.acquire(takeover), [])
  const release = useCallback(() => session.current?.release(), [])
  const refresh = useCallback(() => session.current?.refresh(), [])
  const input = useCallback(
    (action: UiAction, point: Point | null, capturedAt: number) =>
      session.current?.input(action, point, capturedAt) ?? Promise.resolve(false),
    []
  )
  return {
    status,
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
