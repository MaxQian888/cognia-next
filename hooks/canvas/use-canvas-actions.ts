"use client"

/**
 * cognia-next implementation of `useCanvasActions`. The Cognia version
 * pulls in provider-routing, history retention, and review-state — all
 * of which assume settings shapes and provider clients that don't ship
 * in cognia-next. We expose a minimal surface that streams the result
 * of an AI action through the Vercel AI SDK + Anthropic provider that
 * cognia-next already ships.
 */

import { useCallback, useState } from "react"
import { generateText, streamText } from "ai"
import {
  ACTION_PROMPTS,
  buildActionUserPrompt,
  type CanvasActionType,
} from "@/lib/ai/generation/canvas-actions"
import { getProviderModel } from "@cognia/provider-core/core/client"
import { useSettingsStore } from "@/stores/settings"
import { loggers } from "@/lib/logging"

export interface CanvasActionInvocation {
  actionType: CanvasActionType
  content: string
  language?: string
  selection?: string
  prompt?: string
  targetLanguage?: string
}

export interface CanvasActionState {
  running: boolean
  actionType: CanvasActionType | null
  output: string
  error: string | null
}

export interface UseCanvasActionsResult extends CanvasActionState {
  run: (req: CanvasActionInvocation) => Promise<string>
  stream: (req: CanvasActionInvocation, onDelta: (chunk: string) => void) => Promise<string>
  reset: () => void
}

const INITIAL: CanvasActionState = {
  running: false,
  actionType: null,
  output: "",
  error: null,
}

export function useCanvasActions(): UseCanvasActionsResult {
  const [state, setState] = useState<CanvasActionState>(INITIAL)
  const apiKey = useSettingsStore((s) => s.settings?.apiKey)

  const buildModel = useCallback(() => {
    return getProviderModel({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: apiKey ?? undefined,
    })
  }, [apiKey])

  const run = useCallback(
    async (req: CanvasActionInvocation) => {
      setState({ running: true, actionType: req.actionType, output: "", error: null })
      try {
        const system = ACTION_PROMPTS[req.actionType] ?? ACTION_PROMPTS.custom
        const user = buildActionUserPrompt(req)
        const { text } = await generateText({
          model: buildModel(),
          system,
          prompt: user,
        })
        setState({ running: false, actionType: req.actionType, output: text, error: null })
        return text
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        loggers.canvas.error("canvas action run failed", {
          actionType: req.actionType,
          error: message,
        })
        setState({ running: false, actionType: req.actionType, output: "", error: message })
        throw err
      }
    },
    [buildModel]
  )

  const stream = useCallback(
    async (req: CanvasActionInvocation, onDelta: (chunk: string) => void) => {
      setState({ running: true, actionType: req.actionType, output: "", error: null })
      let acc = ""
      try {
        const system = ACTION_PROMPTS[req.actionType] ?? ACTION_PROMPTS.custom
        const user = buildActionUserPrompt(req)
        const result = streamText({ model: buildModel(), system, prompt: user })
        for await (const delta of result.textStream) {
          acc += delta
          onDelta(delta)
          setState((prev) => ({ ...prev, output: acc }))
        }
        setState({ running: false, actionType: req.actionType, output: acc, error: null })
        return acc
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        loggers.canvas.error("canvas action stream failed", {
          actionType: req.actionType,
          partialLength: acc.length,
          error: message,
        })
        setState({ running: false, actionType: req.actionType, output: acc, error: message })
        throw err
      }
    },
    [buildModel]
  )

  const reset = useCallback(() => setState(INITIAL), [])

  return { ...state, run, stream, reset }
}
