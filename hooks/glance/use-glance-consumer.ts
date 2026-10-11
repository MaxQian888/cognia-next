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

export interface UseGlanceConsumerResult {
  snapshot: GlanceSnapshotV1 | null
  /** Resolves to null on success, a `glance.errors.*` key otherwise. */
  send: (body: GlanceRequestBody) => Promise<string | null>
}

export function useGlanceConsumer(
  consumer: string,
  windowLabel: string,
  visible: boolean
): UseGlanceConsumerResult {
  const [snapshot, setSnapshot] = useState<GlanceSnapshotV1 | null>(null)
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
    void onGlanceSnapshot((payload) => {
      if (disposed || !isGlanceSnapshot(payload)) return
      setSnapshot((current) => (isNewerSnapshot(current, payload) ? payload : current))
    }).then(track)
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
    void sendGlanceSubscription({ consumer, windowLabel, visible: true })
    const timer = setInterval(
      () => void sendGlanceSubscription({ consumer, windowLabel, visible: true }),
      GLANCE_LEASE_RENEW_MS
    )
    return () => clearInterval(timer)
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

  return { snapshot, send }
}
