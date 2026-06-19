"use client"

/**
 * useSkillRecording — drive a desktop skill-recording session.
 *
 * Subscribes to the `record:event` channel before starting so no early steps are
 * missed, accumulates observations for a live view, and returns the full trace
 * from `stop()`. Desktop-only: on a non-Tauri runtime `start()` reports
 * "desktop-only" and throws rather than hitting the (rejecting) web transport.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { isTauri } from "@/lib/tauri"
import {
  onRecordEvent,
  recordCancel,
  recordStart,
  recordStop,
} from "@/lib/skills/recording/recorder-client"
import type { Observation, RecordStartArgs, RecordingTrace } from "@/lib/skills/recording/types"

export type RecordingStatus = "idle" | "recording" | "stopping" | "error"

export interface UseSkillRecording {
  status: RecordingStatus
  steps: Observation[]
  error: string | null
  start: (args?: RecordStartArgs) => Promise<void>
  stop: () => Promise<RecordingTrace | null>
  cancel: () => Promise<void>
}

export function useSkillRecording(): UseSkillRecording {
  const [status, setStatus] = useState<RecordingStatus>("idle")
  const [steps, setSteps] = useState<Observation[]>([])
  const [error, setError] = useState<string | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  const detach = useCallback(() => {
    if (unlistenRef.current) {
      try {
        unlistenRef.current()
      } catch {
        // ignore — the channel will be GC'd anyway
      }
      unlistenRef.current = null
    }
  }, [])

  // Detach the event listener on unmount.
  useEffect(() => detach, [detach])

  const start = useCallback(
    async (args?: RecordStartArgs) => {
      if (!isTauri()) {
        setError("desktop-only")
        throw new Error("Skill recording requires desktop mode.")
      }
      setError(null)
      setSteps([])
      detach()
      unlistenRef.current = onRecordEvent((event) => {
        switch (event.type) {
          case "step":
            setSteps((prev) => [...prev, event.observation])
            break
          case "error":
            setError(event.message)
            setStatus("error")
            break
          case "cancelled":
            setStatus("idle")
            break
          default:
            break
        }
      })
      try {
        await recordStart(args)
        setStatus("recording")
      } catch (err) {
        detach()
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setStatus("error")
        throw err
      }
    },
    [detach]
  )

  const stop = useCallback(async (): Promise<RecordingTrace | null> => {
    if (status !== "recording") return null
    setStatus("stopping")
    try {
      const trace = await recordStop()
      setStatus("idle")
      return trace
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus("error")
      return null
    } finally {
      detach()
    }
  }, [status, detach])

  const cancel = useCallback(async () => {
    detach()
    setStatus("idle")
    setSteps([])
    if (isTauri()) {
      try {
        await recordCancel()
      } catch {
        // best effort — the session may already be gone
      }
    }
  }, [detach])

  return { status, steps, error, start, stop, cancel }
}
