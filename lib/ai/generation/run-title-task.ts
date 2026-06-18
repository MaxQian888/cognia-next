/**
 * Surface-agnostic "generate and persist a short title" orchestration.
 *
 * Direct chat, Agent Team chat, workflow runs, and agent-team runs all want
 * the same fire-and-forget pipeline: build the renderer utility-model client,
 * ask the cheap model for a short title, *smooth* the result (don't overwrite
 * with an effectively-identical string), re-check the row is still
 * machine-managed right before writing, then persist. This module owns that
 * orchestration so each surface only supplies its text inputs + a `persist`
 * callback — no surface re-implements `runUtilityModelTasks`.
 *
 * Pure-ish + injectable: `buildUtilityLlmClient` is the only side-effecting
 * dependency, so tests mock it and drive the whole flow with a fake client.
 */

import type { AppSettings, ChatSession, UtilityModelConfig } from "@/lib/claude/types"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { generateConversationTitle } from "@/lib/ai/generation/title"

/** Placeholder titles a brand-new session/run carries before it gets a real one. */
const PLACEHOLDER_TITLES = new Set(["New chat", "New conversation"])

/**
 * True when `title` is empty or one of the known machine placeholders — i.e.
 * the instant first-message preview is allowed to claim it. A user rename
 * replaces the placeholder, so this also doubles as the "not yet renamed"
 * gate for the instant-preview write in the chat hooks.
 */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  return !title || PLACEHOLDER_TITLES.has(title)
}

/**
 * Decide whether the turn-complete path should generate an LLM title: the
 * feature is on, this is the first assistant turn, and the title hasn't been
 * manually set (`titleAuto !== false`). Shared by the chat + team hooks.
 */
export function shouldGenerateTitle(opts: {
  titleEnabled: boolean | undefined
  assistantCount: number
  titleAuto: boolean | undefined
}): boolean {
  return opts.titleEnabled !== false && opts.assistantCount === 1 && opts.titleAuto !== false
}

/**
 * Whether two titles are "the same" for smoothing purposes — case-folded with
 * collapsed whitespace. When the LLM title matches the instant preview we skip
 * the write entirely, so the visible title never jumps to an identical value.
 */
export function titlesEquivalent(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()
  return norm(a) === norm(b)
}

export interface RunTitleTaskArgs {
  /** Session used for provider/model resolution (null for non-chat runs). */
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Per-feature utility-model override (e.g. `settings.conversationTitle`). */
  override?: UtilityModelConfig
  /** Telemetry-only feature id forwarded to the client resolver. */
  featureId: string
  /** Primary text to title (first user message / task description). */
  sourceText: string
  /** Optional secondary text (first assistant reply / run result). */
  resultText?: string
  /** UI locale so the title language matches the user. */
  locale?: string
  /** Framing of the title; defaults to "chat". See `GenerateTitleArgs.kind`. */
  kind?: "chat" | "work"
  /** Title currently shown; an equivalent generated title is dropped (smoothing). */
  currentTitle?: string
  /** Re-checked just before persisting; return false to abort (e.g. user renamed). */
  isStillAuto?: () => boolean | Promise<boolean>
  /** Persist the accepted title. */
  persist: (title: string) => void | Promise<void>
}

/**
 * Run the full generate-smooth-persist pipeline. Returns the persisted title,
 * or `null` when nothing was written (disabled, no client, empty/equivalent
 * result, no-longer-auto, or any error). Never throws — fire-and-forget.
 */
export async function runTitleTask(args: RunTitleTaskArgs): Promise<string | null> {
  const {
    session,
    appSettings,
    override,
    featureId,
    sourceText,
    resultText,
    locale,
    kind,
    currentTitle,
    isStillAuto,
    persist,
  } = args

  try {
    if (override?.enabled === false) return null
    if (!sourceText.trim()) return null

    const client = buildUtilityLlmClient({ session, appSettings, override, featureId })
    if (!client) return null

    const title = await generateConversationTitle(client, {
      firstUserText: sourceText,
      firstAssistantText: resultText,
      locale,
      kind,
    })
    if (!title) return null

    // Smoothing — skip a write that wouldn't visibly change the title.
    if (currentTitle && titlesEquivalent(title, currentTitle)) return null

    // Re-check freshness: the user may have renamed while the model ran.
    if (isStillAuto) {
      const stillAuto = await isStillAuto()
      if (!stillAuto) return null
    }

    await persist(title)
    return title
  } catch {
    return null
  }
}
