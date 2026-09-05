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
 *
 * Suggestions come back as a SCHEMA-VALIDATED object, not as JSON fished out of
 * prose. The old reader took `indexOf("{")` to `lastIndexOf("}")`, which
 * mis-sliced whenever the model wrapped its answer in a fence, wrote a sentence
 * containing a brace, or emitted two objects; and the shape check that followed
 * was a hand-written `typeof` filter that silently dropped anything it did not
 * recognise. A rejected field is now a validation failure with a reason.
 */

import { useCallback, useState } from "react"
import { generateObject } from "ai"
import { z } from "zod"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { getProviderModel } from "@cognia/provider-core/core/client"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { buildScopeBlock } from "@/lib/canvas/ai/context-analyzer"
import { loggers } from "@cognia/logging"
import { hasNoLeakingPii } from "@cognia/redact"
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
  /**
   * `assist` proposes polish around the caret; `review` reads the whole
   * document and reports findings. Both produce anchored suggestions, which is
   * what makes a review something the user can accept hunk by hunk instead of
   * a paragraph of prose.
   */
  mode?: CanvasSuggestionMode
  abortSignal?: AbortSignal
}

const SYSTEM_PROMPT = `You are an expert code/text editing assistant. Given a document and the user's
current cursor / selection context, propose AT MOST {{N}} concise, mechanical suggestions
that improve correctness, readability, or style.

Quote \`originalText\` verbatim from the document and give the 1-based line range it
covers. \`confidence\` is how sure you are the change is correct and wanted.
If no useful suggestion exists, return an empty list.`

/**
 * A review pass rather than a caret-local one: the whole document is in scope,
 * and the interesting output is problems, not polish. `review` used to produce
 * a wall of prose that nothing rendered, so it is anchored suggestions now.
 */
const REVIEW_SYSTEM_PROMPT = `You are a meticulous reviewer. Read the whole document and report AT MOST {{N}}
specific, actionable findings: bugs, incorrect logic, unhandled edge cases, factual
errors, and clear violations of the conventions the document itself establishes.

Each finding must be anchored: quote \`originalText\` verbatim from the document, give
the 1-based line range it covers, and put the corrected text in \`suggestedText\`. When a
finding is a warning with no mechanical fix, repeat the original text as the suggestion
and use type "comment". \`confidence\` is how sure you are the finding is real.
If the document has no findings worth reporting, return an empty list.`

/**
 * The contract the model answers against. Line numbers are 1-based and inclusive,
 * matching `CanvasSuggestion["range"]` and the editor's own coordinates.
 */
const SUGGESTION_SCHEMA = z.object({
  suggestions: z.array(
    z.object({
      type: z.enum(["fix", "improve", "edit", "comment"]).describe("What kind of change this is"),
      explanation: z.string().describe("One sentence, in the user's own language"),
      originalText: z.string().describe("Verbatim text from the document"),
      suggestedText: z.string().describe("What it should say instead"),
      confidence: z.number().min(0).max(1).optional(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
  ),
})

export type CanvasSuggestionMode = "assist" | "review"

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

/**
 * A 0-1 confidence, or `undefined` when the model omitted it or answered with
 * something that is not a usable number. Percentages (a model that answers
 * `85`) are normalised rather than dropped; anything else is discarded, since a
 * made-up number is worse than no badge at all.
 *
 * The schema already narrows confidence to 0-1, so this now runs only on the
 * looser inputs that reach it from tests and from a provider whose structured
 * output arrived as a string.
 */
export function normalizeConfidence(raw: unknown): number | undefined {
  const value = typeof raw === "string" ? Number(raw.replace("%", "").trim()) : raw
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value >= 0 && value <= 1) return value
  if (value > 1 && value <= 100) return value / 100
  return undefined
}

/**
 * Turn a validated object into store-shaped suggestions.
 *
 * The schema guarantees the field types; what it cannot guarantee is that the
 * line range makes sense, so an inverted or degenerate range is repaired here
 * rather than anchoring a suggestion to nothing.
 */
export function toCanvasSuggestions(
  parsed: z.infer<typeof SUGGESTION_SCHEMA>,
  max: number
): Omit<CanvasSuggestion, "id">[] {
  return parsed.suggestions.slice(0, max).map((s) => {
    const startLine = Math.max(1, Math.min(s.startLine, s.endLine))
    const endLine = Math.max(startLine, Math.max(s.startLine, s.endLine))
    const confidence = normalizeConfidence(s.confidence)
    return {
      type: s.type,
      explanation: s.explanation,
      originalText: s.originalText,
      suggestedText: s.suggestedText,
      range: { startLine, endLine },
      ...(confidence !== undefined ? { confidence } : {}),
      status: "pending" as const,
    }
  })
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
      const mode = opts.mode ?? "assist"
      // A review reads the whole document by definition, so the caret window
      // that keeps an assist pass cheap would defeat it.
      const contextLines = mode === "review" ? 0 : (opts.contextLines ?? ai.contextLines)
      setRunning(true)
      setError(null)
      try {
        const windowed = sliceContextWindow(ctx.content, ctx.cursorLine, contextLines)
        const system = (mode === "review" ? REVIEW_SYSTEM_PROMPT : SYSTEM_PROMPT).replace(
          "{{N}}",
          String(max)
        )
        // The window above is a slice around the caret, so it drops exactly the
        // things a good suggestion needs: which function/class the caret sits in,
        // and what the file exports and depends on. Those are cheap to derive
        // locally from the FULL document and expensive for the model to guess.
        // Bounded to `SCOPE_BLOCK_MAX_CHARS`; `null` when there is nothing to say.
        const scope = buildScopeBlock(
          ctx.content,
          { line: ctx.cursorLine ?? 1, column: ctx.cursorColumn ?? 1 },
          String(ctx.language)
        )
        const prompt = `Language: ${ctx.language}\nDocument:\n\n${windowed}\n\n${
          ctx.selectionText ? `User selection:\n${ctx.selectionText}\n\n` : ""
        }${scope ? `${scope}\n\n` : ""}${
          ctx.cursorLine !== undefined ? `Cursor line: ${ctx.cursorLine}` : ""
        }`
        if (!hasNoLeakingPii(system) || !hasNoLeakingPii(prompt)) {
          throw new Error("Canvas suggestions blocked by PII gate")
        }
        const { object } = await generateObject({
          model: buildModel(),
          schema: SUGGESTION_SCHEMA,
          system,
          prompt,
          abortSignal: opts.abortSignal,
        })
        const parsed = toCanvasSuggestions(object, max)
        for (const s of parsed) {
          addSuggestion(ctx.documentId, s)
        }
        return parsed
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        loggers.canvas.error("canvas suggestion generation failed", {
          documentId: ctx.documentId,
          language: ctx.language,
          mode,
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
