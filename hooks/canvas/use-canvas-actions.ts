"use client"

/**
 * The Canvas AI workbench's execution hook.
 *
 * It owns the *state* of a run (what is running, its streamed output, whether
 * it can be cancelled or retried) and nothing about how a prompt is built or
 * sent: that is `lib/ai/generation/canvas-actions.ts`, which both this hook and
 * the plugin API call. Before the split, this hook had its own prompt builder
 * and its own PII check while the plugin path had a different builder and no
 * check at all.
 *
 * Cancellation is a real `AbortController` handed to the AI SDK, not a flag the
 * UI reads while the request keeps running. Retry replays the last invocation
 * verbatim, which is what makes a transient provider failure a one-click
 * recovery instead of a re-typed instruction.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CanvasActionPiiBlockedError,
  runCanvasAction,
  streamCanvasAction,
  type CanvasActionType,
} from "@/lib/ai/generation/canvas-actions"
import { getProviderModel } from "@cognia/provider-core/core/client"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { useSettingsStore } from "@/stores/settings"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { loggers } from "@cognia/logging"
import type { CanvasActionAttachment } from "@/types/artifact/artifact"

export interface CanvasActionInvocation {
  actionType: CanvasActionType
  content: string
  language?: string
  selection?: string
  prompt?: string
  targetLanguage?: string
  /** Extra context staged in the workbench (other documents, artifacts, replies). */
  attachments?: CanvasActionAttachment[]
}

/** Why a run ended without a result, so the UI can say something useful. */
export type CanvasActionErrorKind = "pii-blocked" | "cancelled" | "failed"

export interface CanvasActionState {
  running: boolean
  actionType: CanvasActionType | null
  output: string
  error: string | null
  errorKind: CanvasActionErrorKind | null
  /** True while a run is in flight and can still be aborted. */
  cancellable: boolean
  /** True when the last run failed in a way a retry could fix. */
  retryable: boolean
}

export interface UseCanvasActionsResult extends CanvasActionState {
  run: (req: CanvasActionInvocation) => Promise<string>
  stream: (req: CanvasActionInvocation, onDelta: (chunk: string) => void) => Promise<string>
  cancel: () => void
  /** Re-run the last invocation exactly as it was sent. */
  retry: () => Promise<string>
  reset: () => void
}

const INITIAL: CanvasActionState = {
  running: false,
  actionType: null,
  output: "",
  error: null,
  errorKind: null,
  cancellable: false,
  retryable: false,
}

function classifyError(error: unknown): CanvasActionErrorKind {
  if (error instanceof CanvasActionPiiBlockedError) return "pii-blocked"
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "cancelled"
  }
  return "failed"
}

export function useCanvasActions(): UseCanvasActionsResult {
  const [state, setState] = useState<CanvasActionState>(INITIAL)
  const settings = useSettingsStore((s) => s.settings)
  // Settings, Canvas, AI, "Stream responses". This is the switch's first
  // reader: it shipped disabled with a "no runtime consumer" note because both
  // execution paths were hard-wired, one to generate and one to stream.
  const streamingResponses = useCanvasSettingsStore((s) => s.settings.ai.streamingResponses)
  const abortRef = useRef<AbortController | null>(null)
  const lastRequestRef = useRef<{
    req: CanvasActionInvocation
    onDelta: ((chunk: string) => void) | null
  } | null>(null)

  const buildModel = useCallback(() => {
    // Prefer the user's configured provider (any of Anthropic/OpenAI/Google/…)
    // resolved from settings, with the streaming-capable fetch + browser-direct
    // headers, which is what makes standalone BYOK on non-Anthropic providers
    // work. Falls back to the legacy single-key Anthropic path for users whose
    // key isn't in `providerSettings` (e.g. subscription/OAuth on desktop).
    const resolution = resolveStandaloneProvider(settings)
    if (resolution.kind === "resolved") {
      return createFeatureProviderModel(resolution, {
        fetch: getStreamingFetch(),
        headers: browserDirectHeaders(resolution.protocol),
      })
    }
    return getProviderModel({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: settings?.apiKey ?? undefined,
    })
  }, [settings])

  const execute = useCallback(
    async (req: CanvasActionInvocation, onDelta: ((chunk: string) => void) | null) => {
      // A second run supersedes the first rather than racing it into the same
      // output buffer.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      lastRequestRef.current = { req, onDelta }

      setState({
        running: true,
        actionType: req.actionType,
        output: "",
        error: null,
        errorKind: null,
        cancellable: true,
        retryable: false,
      })

      const options = {
        language: req.language,
        targetLanguage: req.targetLanguage,
        selection: req.selection,
        prompt: req.prompt,
        attachments: req.attachments,
        abortSignal: controller.signal,
      }

      let accumulated = ""
      try {
        // Stream whenever the caller wants deltas, or whenever the setting asks
        // for it. A toolbar action still benefits from partial output landing
        // in the panel while a long rewrite is in flight.
        const shouldStream = onDelta !== null || streamingResponses
        if (shouldStream) {
          accumulated = await streamCanvasAction(
            buildModel(),
            req.actionType,
            req.content,
            (delta) => {
              accumulated += delta
              onDelta?.(delta)
              setState((prev) => (prev.running ? { ...prev, output: accumulated } : prev))
            },
            options
          )
        } else {
          accumulated = await runCanvasAction(buildModel(), req.actionType, req.content, options)
        }

        if (controller.signal.aborted) {
          // The abort landed between the last delta and here. Do not publish a
          // result the user has already asked us to drop.
          throw new DOMException("Canvas action cancelled", "AbortError")
        }

        setState({
          running: false,
          actionType: req.actionType,
          output: accumulated,
          error: null,
          errorKind: null,
          cancellable: false,
          retryable: false,
        })
        return accumulated
      } catch (err) {
        const kind = classifyError(err)
        const message = err instanceof Error ? err.message : String(err)
        // A cancellation is a user decision, not an incident.
        if (kind !== "cancelled") {
          loggers.canvas.error("canvas action failed", {
            actionType: req.actionType,
            kind,
            partialLength: accumulated.length,
            error: message,
          })
        }
        setState({
          running: false,
          actionType: req.actionType,
          // Partial output survives a failure: half a rewrite is still worth
          // reading, and it is what the user watched arrive.
          output: accumulated,
          error: message,
          errorKind: kind,
          cancellable: false,
          // A redaction refusal will refuse identically next time, so offering
          // a retry there would just be a button that always fails.
          retryable: kind === "failed",
        })
        throw err
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [buildModel, streamingResponses]
  )

  const run = useCallback((req: CanvasActionInvocation) => execute(req, null), [execute])

  const stream = useCallback(
    (req: CanvasActionInvocation, onDelta: (chunk: string) => void) => execute(req, onDelta),
    [execute]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const retry = useCallback(() => {
    const last = lastRequestRef.current
    if (!last) return Promise.resolve("")
    return execute(last.req, last.onDelta)
  }, [execute])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    lastRequestRef.current = null
    setState(INITIAL)
  }, [])

  // An unmount while a request is in flight would otherwise leave the provider
  // call running and its result dropped on the floor.
  useEffect(() => () => abortRef.current?.abort(), [])

  return { ...state, run, stream, cancel, retry, reset }
}
