"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { EmbeddedEngine } from "@/lib/browser/agent-engine"
import { BROWSER_EVENTS, type BrowserLoaded, type BrowserNavigated } from "@/lib/browser/protocol"
import { FlowRecorder } from "@/lib/browser/recording/recorder"
import {
  requiredSecrets,
  type RecordedFlow,
  type RecordedStep,
} from "@/lib/browser/recording/protocol"
import { replayFlow, type ReplayStepResult } from "@/lib/browser/recording/replayer"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export interface UseFlowRecorder {
  recording: boolean
  steps: RecordedStep[]
  /** Non-null while a replay is in flight; the last settled step. */
  replayProgress: ReplayStepResult | null
  replaying: boolean
  start: (baseUrl: string) => Promise<void>
  /** Stop and return the finished flow (null when nothing was recording). */
  stop: () => Promise<RecordedFlow | null>
  addAssertion: (text: string) => void
  removeStep: (index: number) => void
  replay: (flow: RecordedFlow, secrets?: Record<string, string>) => Promise<boolean>
  stopReplay: () => void
  /** Secret keys the given flow needs before it can replay. */
  secretsFor: (flow: RecordedFlow) => string[]
}

export interface UseFlowRecorderOptions {
  /** Injected clock — `Date.now` is lint-banned and this keeps tests assertable. */
  now?: () => number
}

/**
 * React binding for {@link FlowRecorder} + {@link replayFlow}. See ADR-0072.
 *
 * It owns the two pane events the page cannot see for itself: `navigated`
 * becomes a step, and `loaded` drains-then-re-arms the page (a navigation
 * destroys the page's JS context). Teardown uses {@link safeUnlisten} for the
 * StrictMode mount→unmount→mount race.
 */
export function useFlowRecorder(options: UseFlowRecorderOptions = {}): UseFlowRecorder {
  const { now } = options
  const [recording, setRecording] = useState(false)
  const [steps, setSteps] = useState<RecordedStep[]>([])
  const [replayProgress, setReplayProgress] = useState<ReplayStepResult | null>(null)
  const [replaying, setReplaying] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const engine = useMemo(() => new EmbeddedEngine(), [])

  const recorder = useMemo(
    () => new FlowRecorder({ now: now ?? (() => Date.now()), onChange: setSteps }),
    [now]
  )

  // The page buffers element interactions but cannot report its own
  // navigations, and it loses its buffer whenever a document is replaced.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const subs: Array<() => void> = []
    const add = async <T>(event: string, handler: (p: T) => void) => {
      const unlisten = await onTauriEvent<T>(event, handler)
      if (cancelled) unlisten()
      else subs.push(unlisten)
    }
    void add<BrowserNavigated>(BROWSER_EVENTS.navigated, (p) => recorder.noteNavigation(p.url))
    void add<BrowserLoaded>(BROWSER_EVENTS.loaded, () => void recorder.noteLoaded())
    return () => {
      cancelled = true
      for (const unlisten of subs) safeUnlisten(unlisten)
    }
  }, [recorder])

  // A take must not outlive the pane, or the page stays armed with nobody
  // draining it.
  useEffect(() => {
    return () => {
      if (recorder.recording) void recorder.cancel()
    }
  }, [recorder])

  const start = useCallback(
    async (baseUrl: string) => {
      await recorder.start(baseUrl)
      setRecording(true)
    },
    [recorder]
  )

  const stop = useCallback(async () => {
    const flow = await recorder.stop()
    setRecording(false)
    return flow
  }, [recorder])

  const addAssertion = useCallback((text: string) => recorder.addAssertion(text), [recorder])
  const removeStep = useCallback((index: number) => recorder.removeStep(index), [recorder])

  const replay = useCallback(
    async (flow: RecordedFlow, secrets?: Record<string, string>) => {
      const controller = new AbortController()
      abortRef.current = controller
      setReplaying(true)
      setReplayProgress(null)
      try {
        const result = await replayFlow(flow, engine, {
          secrets,
          signal: controller.signal,
          onStep: setReplayProgress,
        })
        return result.ok
      } finally {
        setReplaying(false)
        abortRef.current = null
      }
    },
    [engine]
  )

  const stopReplay = useCallback(() => abortRef.current?.abort(), [])

  const secretsFor = useCallback((flow: RecordedFlow) => requiredSecrets(flow), [])

  return {
    recording,
    steps,
    replayProgress,
    replaying,
    start,
    stop,
    addAssertion,
    removeStep,
    replay,
    stopReplay,
    secretsFor,
  }
}
