"use client"

/**
 * cognia-next implementation of `useCanvasSuggestions`. Generates AI edit
 * suggestions for the active canvas document and stores them through the
 * artifact store (`addSuggestion`).
 *
 * The generator now honors `CanvasAISettings` (Settings → Canvas → AI) instead
 * of hardcoding the model / suggestion count / context size:
 *  - provider: `suggestionProvider === "custom"` routes through
 *    `customProviderUrl` (OpenAI-compatible); otherwise the user's configured
 *    app provider is used (via `resolveStandaloneProvider`, same as canvas actions).
 *  - `maxSuggestions` caps the count, `contextLines` trims the prompt to a window
 *    around the caret so large documents don't blow the context / cost.
 */

import { useCallback, useState } from "react"
import { generateText } from "ai"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { getProviderModel } from "@cognia/provider-core/core/client"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { loggers } from "@cognia/logging"
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

/**
 * Trim `content` to a window of `±contextLines` lines around `cursorLine`
 * (1-based). Returns the full document when `contextLines` is not a positive
 * number or the document already fits. Pure — unit-tested directly.
 */
export function sliceContextWindow(
  content: string,
  cursorLine: number | undefined,
  contextLines: number | undefined
): string {
  if (!contextLines || contextLines <= 0) return content
  const lines = content.split("\n")
  if (lines.length <= contextLines * 2 + 1) return content
  const center = cursorLine && cursorLine > 0 ? cursorLine - 1 : 0
  const start = Math.max(0, center - contextLines)
  const end = Math.min(lines.length, center + contextLines + 1)
  return lines.slice(start, end).join("\n")
}

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
  const settings = useSettingsStore((s) => s.settings)
  const ai = useCanvasSettingsStore((s) => s.settings.ai)
  const addSuggestion = useArtifactStore((s) => s.addSuggestion)

  const buildModel = useCallback(() => {
    // Custom endpoint: an OpenAI-compatible gateway the user pointed the canvas at.
    if (ai.suggestionProvider === "custom" && ai.customProviderUrl) {
      return getProviderModel({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: settings?.apiKey ?? undefined,
        baseURL: ai.customProviderUrl,
      })
    }
    // Default: the user's configured app provider (Anthropic/OpenAI/Google/…),
    // mirroring `useCanvasActions`. Falls back to the legacy Anthropic key path.
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
  }, [ai.suggestionProvider, ai.customProviderUrl, settings])

  const generate = useCallback(
    async (ctx: SuggestionContext, opts: GenerateSuggestionsOptions = {}) => {
      const max = opts.maxSuggestions ?? ai.maxSuggestions ?? 5
      const contextLines = opts.contextLines ?? ai.contextLines
      setRunning(true)
      setError(null)
      try {
        const windowed = sliceContextWindow(ctx.content, ctx.cursorLine, contextLines)
        const { text } = await generateText({
          model: buildModel(),
          system: SYSTEM_PROMPT.replace("{{N}}", String(max)),
          prompt: `Language: ${ctx.language}\nDocument:\n\n${windowed}\n\n${
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
    [addSuggestion, ai.maxSuggestions, ai.contextLines, buildModel]
  )

  return { generate, running, error }
}
