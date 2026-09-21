"use client"

// The settings editor's AI assist — state for the three template operations
// in `lib/ai/generation/template-assist.ts`.
//
// Same contract `useCanvasActions` established for the Canvas workbench:
// the hook owns run state (running, which op, error, cancellable) and the
// AbortController; prompt construction and the PII gate stay in the lib so
// this file never builds a string a model sees. A second click supersedes the
// first rather than racing two writes into the same form.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  applyParamSuggestions,
  generateTemplateDraft,
  improveTemplateBody,
  suggestTemplateParams,
  TemplateAssistPiiBlockedError,
  type TemplateDraft,
} from "@/lib/ai/generation/template-assist"
import { getProviderModel } from "@cognia/provider-core/core/client"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { useSettingsStore } from "@/stores/settings"
import type { ChatTemplateParam } from "@/lib/chat/template/template"
import { loggers } from "@cognia/logging"

export type TemplateAssistOp = "generate" | "improve" | "suggest"

export type TemplateAssistErrorKind = "pii-blocked" | "cancelled" | "failed"

export interface TemplateAssistState {
  running: boolean
  /** Which operation is in flight — the UI spins that button, not all three. */
  op: TemplateAssistOp | null
}

/**
 * What an operation resolves to. `null` means "nothing to react to" — the run
 * was cancelled or superseded by a newer one. A failure object carries the
 * error inline because the caller's `assist.error` is a render-time snapshot:
 * by the time the promise settles that snapshot is stale, so the outcome must
 * travel inside the promise itself.
 */
export type TemplateAssistOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: Exclude<TemplateAssistErrorKind, "cancelled">; error: string }
  | null

export interface UseTemplateAssistResult extends TemplateAssistState {
  /** Intent -> draft. */
  generate: (intent: string) => Promise<TemplateAssistOutcome<TemplateDraft>>
  /** Body -> rewritten body. */
  improve: (body: string, instruction?: string) => Promise<TemplateAssistOutcome<string>>
  /** Body -> declarations, merged over `existing`. */
  suggest: (
    body: string,
    existing: readonly ChatTemplateParam[]
  ) => Promise<TemplateAssistOutcome<ChatTemplateParam[]>>
  cancel: () => void
}

const INITIAL: TemplateAssistState = { running: false, op: null }

function classify(error: unknown): TemplateAssistErrorKind {
  if (error instanceof TemplateAssistPiiBlockedError) return "pii-blocked"
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "cancelled"
  }
  return "failed"
}

export function useTemplateAssist(): UseTemplateAssistResult {
  const [state, setState] = useState<TemplateAssistState>(INITIAL)
  const settings = useSettingsStore((s) => s.settings)
  const abortRef = useRef<AbortController | null>(null)

  // The user's own configured provider, resolved the same way the standalone
  // chat path resolves it; the legacy single-key Anthropic fallback covers
  // subscription/OAuth setups whose key never entered `providerSettings`.
  const buildModel = useCallback(() => {
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
    async <T>(
      op: TemplateAssistOp,
      call: (signal: AbortSignal) => Promise<T>
    ): Promise<TemplateAssistOutcome<T>> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setState({ running: true, op })
      try {
        const result = await call(controller.signal)
        if (controller.signal.aborted || abortRef.current !== controller) {
          throw new DOMException("Template assist cancelled", "AbortError")
        }
        setState(INITIAL)
        return { ok: true, value: result }
      } catch (err) {
        const kind = classify(err)
        const message = err instanceof Error ? err.message : String(err)
        // A superseded run's late rejection must not idle out — or flag an
        // error on — the run that replaced it. Only the owner writes state
        // and only the owner's caller learns why.
        if (abortRef.current !== controller) return null
        if (kind === "cancelled") {
          // A cancelled run is a decision, not an incident — clear quietly.
          setState(INITIAL)
          return null
        }
        if (kind === "failed") {
          loggers.chat.warn("template assist failed", { op, error: message })
        }
        setState(INITIAL)
        return { ok: false, kind, error: message }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    []
  )

  const generate = useCallback(
    (intent: string) =>
      execute("generate", (signal) =>
        generateTemplateDraft(buildModel(), intent, { abortSignal: signal })
      ),
    [buildModel, execute]
  )

  const improve = useCallback(
    (body: string, instruction?: string) =>
      execute("improve", (signal) =>
        improveTemplateBody(buildModel(), body, {
          ...(instruction ? { instruction } : {}),
          abortSignal: signal,
        })
      ),
    [buildModel, execute]
  )

  const suggest = useCallback(
    async (body: string, existing: readonly ChatTemplateParam[]) =>
      execute("suggest", async (signal) => {
        const suggestions = await suggestTemplateParams(buildModel(), body, {
          abortSignal: signal,
        })
        return applyParamSuggestions(body, existing, suggestions)
      }),
    [buildModel, execute]
  )

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  // An unmount mid-run would drop the result on the floor and leave the
  // provider call burning.
  useEffect(() => () => abortRef.current?.abort(), [])

  return { ...state, generate, improve, suggest, cancel }
}
