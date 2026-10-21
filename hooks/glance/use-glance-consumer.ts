"use client"

/**
 * The consumer half of the glance channel, for a desktop window that renders
 * a `GlanceSnapshotV1` (the tray panel today; ADR-0225 §7).
 *
 * While `visible`, it holds a lease on the main window's publisher (announce
 * now, renew on an interval) and keeps the newest snapshot by epoch and
 * revision. Hidden, it ends the lease so the publisher stops computing.
 * `send` pairs each request with its result; a request the main window never
 * answers resolves to a timeout error instead of hanging a spinner forever.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import type { GlanceRequestBody } from "@/lib/glance/requests"
import { isGlanceSnapshot, isNewerSnapshot, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import {
  GLANCE_LEASE_RENEW_MS,
  onGlanceResult,
  onGlanceSnapshot,
  sendGlanceRequest,
  sendGlanceSubscription,
} from "@/lib/tauri/glance"

/** A request with no result after this long resolves as a timeout. */
export const GLANCE_REQUEST_TIMEOUT_MS = 15_000
/** Retry until a publisher that may still be loading answers the first lease. */
export const GLANCE_CONNECT_RETRY_MS = 1_000

export interface UseGlanceConsumerResult {
  snapshot: GlanceSnapshotV1 | null
  /**
   * How many newer snapshots have arrived since mount. A consumer that needs
   * "the first snapshot after X" records this at X and waits for it to grow.
   */
  receivedCount: number
  connectionError: string | null
  /** Resolves to null on success, a `glance.errors.*` key otherwise. */
  send: (body: GlanceRequestBody) => Promise<string | null>
}

export function useGlanceConsumer(
  consumer: string,
  windowLabel: string,
  visible: boolean
): UseGlanceConsumerResult {
  const [snapshot, setSnapshot] = useState<GlanceSnapshotV1 | null>(null)
  const [receivedCount, setReceivedCount] = useState(0)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const latestRef = useRef<GlanceSnapshotV1 | null>(null)
  const deliveredRef = useRef(0)
  const snapshotListening = useRef<Promise<boolean>>(Promise.resolve(false))
  const pending = useRef(
    new Map<
      string,
      { resolve: (errorKey: string | null) => void; timer: ReturnType<typeof setTimeout> }
    >()
  )

  // Snapshots and results: listen for the window's whole life.
  useEffect(() => {
    let disposed = false
    const offs: Array<() => void> = []
    const track = (off: () => void) => (disposed ? off() : offs.push(off))
    snapshotListening.current = onGlanceSnapshot((payload) => {
      if (disposed || !isGlanceSnapshot(payload)) return
      // A live publisher may acknowledge a re-open with the same revision.
      // Delivery confirms the connection; only newer data advances freshness.
      deliveredRef.current += 1
      setConnectionError(null)
      if (!isNewerSnapshot(latestRef.current, payload)) return
      latestRef.current = payload
      setSnapshot(payload)
      setReceivedCount((count) => count + 1)
    })
      .then((off) => {
        track(off)
        return !disposed
      })
      .catch(() => false)
    void onGlanceResult((result) => {
      const entry = pending.current.get(result.requestId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.current.delete(result.requestId)
      entry.resolve(result.ok ? null : (result.errorKey ?? "errors.requestFailed"))
    }).then(track)
    const inflight = pending.current
    return () => {
      disposed = true
      offs.forEach((off) => off())
      for (const entry of inflight.values()) {
        clearTimeout(entry.timer)
        entry.resolve("errors.requestFailed")
      }
      inflight.clear()
    }
  }, [])

  // The lease: announce on becoming visible, renew while visible, end on hide.
  useEffect(() => {
    if (!visible) {
      void sendGlanceSubscription({ consumer, windowLabel, visible: false })
      return
    }
    let disposed = false
    const baseline = deliveredRef.current
    const startedAt = Date.now()
    let lastAnnouncedAt = startedAt
    let listening = false
    const announce = () => {
      lastAnnouncedAt = Date.now()
      void sendGlanceSubscription({ consumer, windowLabel, visible: true }).then((sent) => {
        if (!disposed && !sent && deliveredRef.current === baseline)
          setConnectionError("errors.deliveryFailed")
      })
    }
    void snapshotListening.current.then((ready) => {
      if (disposed) return
      listening = ready
      if (ready) announce()
      else setConnectionError("errors.deliveryFailed")
    })
    const timer = setInterval(() => {
      const waiting = deliveredRef.current === baseline
      const now = Date.now()
      if (listening && (waiting || now - lastAnnouncedAt >= GLANCE_LEASE_RENEW_MS)) announce()
      if (waiting && now - startedAt >= GLANCE_REQUEST_TIMEOUT_MS) {
        setConnectionError("errors.timeout")
      }
    }, GLANCE_CONNECT_RETRY_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [consumer, windowLabel, visible])

  const send = useCallback(
    (body: GlanceRequestBody): Promise<string | null> =>
      new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          pending.current.delete(requestId)
          resolve("errors.timeout")
        }, GLANCE_REQUEST_TIMEOUT_MS)
        pending.current.set(requestId, { resolve, timer })
        void sendGlanceRequest({ ...body, requestId, consumer } as Parameters<
          typeof sendGlanceRequest
        >[0]).then((sent) => {
          if (sent) return
          clearTimeout(timer)
          pending.current.delete(requestId)
          resolve("errors.deliveryFailed")
        })
      }),
    [consumer]
  )

  return { snapshot, receivedCount, connectionError, send }
}
