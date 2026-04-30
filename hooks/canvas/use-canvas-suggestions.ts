"use client"

/**
 * cognia-next implementation of `useCanvasSuggestions`. The Cognia
 * version routes through a provider-consumption layer that doesn't
 * exist here; instead we hit the Anthropic model directly via
 * `@ai-sdk/anthropic` and store suggestions through the artifact
 * store (`addSuggestion`).
 */

import { useCallback, useState } from "react"
import { generateText } from "ai"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { getProviderModel } from "@/lib/ai/core/client"
import { loggers } from "@/lib/logger"
import type { CanvasSuggestion, ArtifactLanguage } from "@/types"

export interface SuggestionContext {
  documentId: string
  language: ArtifactLanguage | string
  content: string
  cursorLine?: number
  cursorColumn?: number
  selectionText?: string
}

export interface GenerateSuggestionsOptions {
  maxSuggestions?: number
  contextLines?: number
}

const SYSTEM_PROMPT = `You are an expert code/text editing assistant. Given a document and the user's
current cursor / selection context, propose AT MOST {{N}} concise, mechanical suggestions
that improve correctness, readability, or style.

Respond as JSON: {"suggestions":[{"type":"fix|improve|edit|comment",
  "explanation":"<one sentence>",
  "originalText":"<verbatim>",
  "suggestedText":"<verbatim>",
  "startLine":N,"endLine":N}]}.

If no useful suggestion exists, return {"suggestions":[]}.`

interface RawSuggestion {
  type?: CanvasSuggestion["type"]
  explanation?: string
  originalText?: string
  suggestedText?: string
  startLine?: number
  endLine?: number
}

function parseSuggestions(text: string, max: number): Omit<CanvasSuggestion, "id">[] {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let parsed: { suggestions?: RawSuggestion[] } = {}
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch (err) {
    loggers.canvas.warn("canvas suggestions parse failed", {
      error: String(err),
      preview: trimmed.slice(0, 200),
    })
    return []
  }
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  return list
    .slice(0, max)
    .filter(
      (s): s is RawSuggestion =>
        typeof s.suggestedText === "string" &&
        typeof s.originalText === "string" &&
        typeof s.startLine === "number" &&
        typeof s.endLine === "number"
    )
    .map((s) => ({
      type: (s.type ?? "improve") as CanvasSuggestion["type"],
      explanation: s.explanation ?? "",
      originalText: s.originalText ?? "",
      suggestedText: s.suggestedText ?? "",
      range: { startLine: s.startLine!, endLine: s.endLine! },
      status: "pending" as const,
    }))
}

export function useCanvasSuggestions() {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apiKey = useSettingsStore((s) => s.settings?.apiKey)
  const addSuggestion = useArtifactStore((s) => s.addSuggestion)

  const generate = useCallback(
    async (ctx: SuggestionContext, opts: GenerateSuggestionsOptions = {}) => {
      const max = opts.maxSuggestions ?? 5
      setRunning(true)
      setError(null)
      try {
        const model = getProviderModel({
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          apiKey: apiKey ?? undefined,
        })
        const { text } = await generateText({
          model,
          system: SYSTEM_PROMPT.replace("{{N}}", String(max)),
          prompt: `Language: ${ctx.language}\nDocument:\n\n${ctx.content}\n\n${
            ctx.selectionText ? `User selection:\n${ctx.selectionText}\n\n` : ""
          }${ctx.cursorLine !== undefined ? `Cursor line: ${ctx.cursorLine}` : ""}`,
        })
        const parsed = parseSuggestions(text, max)
        for (const s of parsed) {
          addSuggestion(ctx.documentId, s)
        }
        return parsed
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        loggers.canvas.error("canvas suggestion generation failed", {
          documentId: ctx.documentId,
          language: ctx.language,
          error: m,
        })
        setError(m)
        return []
      } finally {
        setRunning(false)
      }
    },
    [addSuggestion, apiKey]
  )

  return { generate, running, error }
}
