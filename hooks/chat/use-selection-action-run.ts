"use client"

/**
 * One summarize / explain / translate run for the transcript selection capsule.
 *
 * Owns what the panel needs and nothing it draws: which run is current, the text
 * as it streams, per-part progress, and how the run ended. A new run aborts the
 * one before it and a late result from a superseded run is dropped, so the panel
 * can never show one action's title over another's answer.
 *
 * The client is the agent-backed ladder (utility model, then one headless turn)
 * so this works on a subscription install, where the renderer has no key.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useLocale } from "next-intl"

import { buildAgentBackedLlmClient } from "@/lib/ai/generation/agent-backed-client"
import { getSession } from "@/lib/db/sessions"
import { loadMessageBodies } from "@/lib/chat/selection/message-excerpt"
import {
  promptLanguageName,
  runSelectionAction,
  type SelectionAction,
  type SelectionActionOutcome,
  type SelectionActionProgress,
} from "@/lib/chat/selection/run-selection-action"
import { useSettingsStore } from "@/stores/settings"

/** What the runs console shows for the fallback turn, by action. */
export const SELECTION_ACTION_TURN_LABELS: Record<SelectionAction, string> = {
  summarize: "Selection summary",
  explain: "Selection explanation",
  translate: "Selection translation",
}

export interface SelectionRunRequest {
  action: SelectionAction
  /** The selected text. */
  quote: string
  /** The conversation the selection was made in — its model is inherited. */
  sessionId: string
  /** Every message the selection touches, in transcript order. */
  messageIds: readonly string[]
  /**
   * The rendered text around the selection, for explain — used only when the
   * messages are not stored yet. The stored bodies are read in preference.
   */
  context: string
  /** Translate only: the target language tag. */
  targetLocale?: string
}

type Unavailable = Extract<SelectionActionOutcome, { kind: "unavailable" }>["reason"]

export type SelectionRunState =
  | { status: "idle" }
  | {
      status: "running"
      request: SelectionRunRequest
      text: string
      progress: SelectionActionProgress | null
    }
  | { status: "done"; request: SelectionRunRequest; text: string; parts: number }
  /** Stopped by the user. What had streamed is kept — it may be all they needed. */
  | { status: "stopped"; request: SelectionRunRequest; text: string }
  | { status: "unavailable"; request: SelectionRunRequest; reason: Unavailable }
  | { status: "failed"; request: SelectionRunRequest; text: string; message: string }

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

export function useSelectionActionRun() {
  const locale = useLocale()
  const [state, setState] = useState<SelectionRunState>({ status: "idle" })
  const controllerRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)
  // The latest streamed text, flushed at most once a frame: a fast model emits
  // far more deltas than a panel can usefully repaint.
  const pendingTextRef = useRef<string | null>(null)
  const frameRef = useRef<number | null>(null)

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    pendingTextRef.current = null
  }, [])

  const run = useCallback(
    async (request: SelectionRunRequest) => {
      controllerRef.current?.abort()
      cancelFrame()
      const controller = new AbortController()
      controllerRef.current = controller
      const runId = ++runIdRef.current
      const current = () => runIdRef.current === runId
      setState({ status: "running", request, text: "", progress: null })

      let latest = ""
      try {
        const [session, storedContext] = await Promise.all([
          getSession(request.sessionId).catch(() => undefined),
          request.action === "explain"
            ? loadMessageBodies(request.sessionId, request.messageIds).catch(() => null)
            : Promise.resolve(null),
        ])
        const client = await buildAgentBackedLlmClient({
          session: session ?? null,
          appSettings: useSettingsStore.getState().settings,
          featureId: "chat-selection-actions",
          label: SELECTION_ACTION_TURN_LABELS[request.action],
        })
        if (!current()) return
        const outcome = await runSelectionAction({
          action: request.action,
          text: request.quote,
          context: storedContext ?? request.context,
          language: promptLanguageName(
            request.action === "translate" ? (request.targetLocale ?? locale) : locale
          ),
          locale,
          client,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!current()) return
            setState((prev) => (prev.status === "running" ? { ...prev, progress } : prev))
          },
          onPartial: (text) => {
            if (!current()) return
            latest = text
            pendingTextRef.current = text
            if (frameRef.current !== null) return
            frameRef.current = requestAnimationFrame(() => {
              frameRef.current = null
              const next = pendingTextRef.current
              pendingTextRef.current = null
              if (next === null || !current()) return
              setState((prev) => (prev.status === "running" ? { ...prev, text: next } : prev))
            })
          },
        })
        if (!current()) return
        cancelFrame()
        setState(
          outcome.kind === "result"
            ? { status: "done", request, text: outcome.text, parts: outcome.parts }
            : { status: "unavailable", request, reason: outcome.reason }
        )
      } catch (error) {
        if (!current()) return
        cancelFrame()
        if (isAbort(error, controller.signal)) {
          setState({ status: "stopped", request, text: latest })
          return
        }
        setState({
          status: "failed",
          request,
          text: latest,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [cancelFrame, locale]
  )

  /** Stop the current run, keeping what it produced. */
  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  /** Stop and forget the run; the panel closes. */
  const close = useCallback(() => {
    runIdRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    cancelFrame()
    setState({ status: "idle" })
  }, [cancelFrame])

  // A run outlives nothing: leaving the conversation aborts it.
  useEffect(
    () => () => {
      runIdRef.current += 1
      controllerRef.current?.abort()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  return { state, run, stop, close }
}
